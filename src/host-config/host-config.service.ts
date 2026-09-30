import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { ConfigError } from '../config/bootstrap-config.js';
import {
  allowChat,
  dataFolderValue,
  DEFAULT_DATA_FOLDER,
  defaultHostConfig,
  denyChat,
  editHostConfig,
  type HostAllowedChat,
  type HostConfig,
  moveChatId,
  parseHostConfig,
  readHostConfig,
  resolveDataFolder,
  resolveSettingsFolder,
  setDataFolder,
} from '../config/host-config.js';
import { validateWorkingDirectory } from '../config/working-directory.js';
import { ComponentHealth } from '../health/component-health.js';
import { AllowedChat } from '../persistence/entities/allowed-chat.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { SettingsService } from '../settings/settings.service.js';

export const HOST_CONFIG_OPTIONS = Symbol('HOST_CONFIG_OPTIONS');

/** How often the daemon looks for edits to `config.yaml` made by hand. */
export const HOST_CONFIG_TICK_MS = 10_000;

/** Chats a hand edit of `config.yaml` added to or removed from the list. */
export interface AllowedChatsChange {
  added: string[];
  removed: string[];
}

export interface HostConfigOptions {
  /** `config.yaml` in the state directory. */
  file: string;
  /** The workspace; null for a legacy data directory. */
  workspace: string | null;
  /** Where relative paths in the file start: the workspace, or the data directory. */
  base: string;
}

/**
 * `config.yaml`: the data folder and the chats Pero serves. It is read at
 * startup and kept in memory; Pero's own changes (allowing and denying
 * chats, following a chat's new ID, a new data folder) are written back
 * to the file, keeping its comments. Every 10 seconds it looks for edits
 * made by hand: a changed chat list applies at once, a changed `data` or
 * `settings` waits for a restart, and an invalid edit is reported while
 * the last valid version stays in use. The `config` component says which.
 *
 * Until the settings row and the `allowed_chats` table are dropped, it
 * also carries them over: a missing file starts from the default working
 * directory, rows in `allowed_chats` move into the file, and the data
 * folder is copied into the settings row, which the rest of Pero reads.
 */
@Injectable()
export class HostConfigService implements OnModuleInit {
  private readonly logger = new Logger('Config');
  private config: HostConfig = { data: null, settings: null, allowedChats: [] };
  /** `data` and `settings` as Pero uses them: from startup, or set by Pero. */
  private running: Pick<HostConfig, 'data' | 'settings'> = {
    data: null,
    settings: null,
  };
  /** Size and modification time of the version last read or written. */
  private seen: { size: number; mtimeMs: number } | null = null;
  /** The text of the invalid version last reported, so it is logged once. */
  private reported: string | null = null;
  private readonly listeners = new Set<(change: AllowedChatsChange) => void>();

  constructor(
    @Inject(HOST_CONFIG_OPTIONS) private readonly options: HostConfigOptions,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly health: ComponentHealth,
  ) {}

  async onModuleInit(): Promise<void> {
    const current = await this.settings.get();
    this.config =
      readHostConfig(this.options.file) ??
      this.create(current.defaultWorkingDirectory);
    await this.importAllowedChats();

    const folder = await this.checkDataFolder();
    if (folder !== null && folder !== current.defaultWorkingDirectory) {
      await this.settings.setDataFolder(folder);
      this.logger.log(
        `Data folder is ${folder}` +
          (current.defaultWorkingDirectory === null
            ? ''
            : `, was ${current.defaultWorkingDirectory}`),
      );
    }
    this.running = { data: this.config.data, settings: this.config.settings };
    this.remember();
    this.reportHealth();
  }

  @Interval('host-config', HOST_CONFIG_TICK_MS)
  onInterval(): void {
    try {
      this.reload();
    } catch (error) {
      this.logger.error(
        `Could not read ${this.options.file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Takes in an edit of `config.yaml` made since it was last read or
   * written. Nothing happens while its size and modification time stay
   * the same. A valid edit replaces the chat list at once and tells the
   * listeners; an invalid one is reported, once per version, and the last
   * valid version stays in use.
   */
  reload(): void {
    const { file } = this.options;
    let stats;
    try {
      stats = statSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.seen = null;
      this.reject('', `${file} is missing`);
      return;
    }
    if (this.seen?.size === stats.size && this.seen.mtimeMs === stats.mtimeMs) {
      return;
    }
    this.seen = { size: stats.size, mtimeMs: stats.mtimeMs };
    const text = readFileSync(file, 'utf8');
    let next: HostConfig;
    try {
      next = parseHostConfig(file, text);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      this.reject(text, error.message);
      return;
    }
    if (this.reported !== null) {
      this.logger.log(`${file} is valid again`);
      this.reported = null;
    }
    this.take(next);
  }

  /**
   * Calls `listener` each time an edit by hand changes which chats are
   * allowed; returns a function that stops the calls.
   */
  onChatsChange(listener: (change: AllowedChatsChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether Pero runs from a workspace, not a legacy data directory. */
  inWorkspace(): boolean {
    return this.options.workspace !== null;
  }

  /**
   * Where the running Pero's data and settings folders are: as they were
   * at startup, since changing them takes a restart. Null for a legacy
   * data directory, which has no settings folder.
   */
  folders(): {
    workspace: string;
    dataFolder: string;
    settingsFolder: string;
  } | null {
    const { workspace } = this.options;
    if (workspace === null) return null;
    return {
      workspace,
      dataFolder: resolveDataFolder(this.running, workspace, true)!,
      settingsFolder: resolveSettingsFolder(this.running, workspace),
    };
  }

  /** The chats Pero serves, in the file's order. */
  allowedChats(): readonly HostAllowedChat[] {
    return this.config.allowedChats;
  }

  /** Adds chat `chatKey`, labelled `title`; false when it was allowed. */
  allow(chatKey: string, title: string | null): boolean {
    let changed = false;
    const known = this.find(chatKey) !== undefined;
    this.edit((document) => {
      changed = allowChat(document, chatKey, title);
    });
    return changed && !known;
  }

  /** Removes chat `chatKey`; false when it wasn't allowed. */
  deny(chatKey: string): boolean {
    let changed = false;
    this.edit((document) => {
      changed = denyChat(document, chatKey);
    });
    return changed;
  }

  /** Follows chat `from` to its new ID `to`; false when `from` wasn't allowed. */
  moveChat(from: string, to: string): boolean {
    let changed = false;
    this.edit((document) => {
      changed = moveChatId(document, from, to);
    });
    return changed;
  }

  /** Writes `folder` (absolute) as the data folder, which Pero applies at once. */
  setDataFolder(folder: string): void {
    const value = dataFolderValue(folder, this.options.workspace);
    this.edit((document) => setDataFolder(document, value));
    this.running = { ...this.running, data: this.config.data };
    this.reportHealth();
  }

  private find(chatKey: string): HostAllowedChat | undefined {
    return this.config.allowedChats.find((chat) => chat.chatKey === chatKey);
  }

  private edit(change: Parameters<typeof editHostConfig>[1]): void {
    this.config = editHostConfig(this.options.file, change, () =>
      this.template(null),
    );
    // Pero's own change is not an edit by hand for the next look.
    this.remember();
    if (this.reported !== null) {
      this.reported = null;
      this.reportHealth();
    }
  }

  /** Records the file as it is now, so the next look skips it. */
  private remember(): void {
    try {
      const { size, mtimeMs } = statSync(this.options.file);
      this.seen = { size, mtimeMs };
    } catch {
      this.seen = null;
    }
  }

  /** Swaps in a valid version read from the file. */
  private take(next: HostConfig): void {
    const keys = (config: HostConfig) =>
      new Set(config.allowedChats.map((chat) => chat.chatKey));
    const before = keys(this.config);
    const after = keys(next);
    const added = [...after].filter((key) => !before.has(key));
    const removed = [...before].filter((key) => !after.has(key));
    this.config = next;
    this.reportHealth();
    if (added.length === 0 && removed.length === 0) return;
    this.logger.log(
      `Allowed chats changed in ${this.options.file}: ` +
        [
          added.length > 0 ? `added ${added.join(', ')}` : null,
          removed.length > 0 ? `removed ${removed.join(', ')}` : null,
        ]
          .filter((part) => part !== null)
          .join('; '),
    );
    for (const listener of this.listeners) listener({ added, removed });
  }

  /** Keeps the last valid version, and reports `problem` once per version. */
  private reject(text: string, problem: string): void {
    if (text !== this.reported) {
      this.logger.error(`${problem}\nThe last valid version stays in use.`);
      this.reported = text;
    }
    const reason = problem.replace(/:\n\s*/, ': ').split('\n')[0]!;
    this.health.report(
      'config',
      'degraded',
      `${reason}; the last valid version stays in use`,
    );
  }

  /** `config`: `ok`, or which changes are waiting for a restart. */
  private reportHealth(): void {
    const waiting = (['data', 'settings'] as const).filter(
      (key) => this.config[key] !== this.running[key],
    );
    if (waiting.length === 0) {
      this.health.report('config', 'ok');
      return;
    }
    this.health.report(
      'config',
      'degraded',
      `${waiting.join(' and ')} changed in ${this.options.file}; restart Pero to apply`,
    );
  }

  /** Writes a new `config.yaml`, with the default working directory as `data`. */
  private create(defaultWorkingDirectory: string | null): HostConfig {
    const config = editHostConfig(
      this.options.file,
      () => undefined,
      () => this.template(defaultWorkingDirectory),
    );
    this.logger.log(`Created ${this.options.file}`);
    return config;
  }

  private template(folder: string | null): string {
    const { workspace } = this.options;
    if (folder !== null) {
      return defaultHostConfig({ data: dataFolderValue(folder, workspace) });
    }
    return defaultHostConfig({
      data: workspace === null ? null : DEFAULT_DATA_FOLDER,
    });
  }

  /**
   * Moves the rows of the `allowed_chats` table into the file: each chat
   * not listed yet is added, then the rows are deleted. A crash between
   * the two only means adding the same chats again.
   */
  private async importAllowedChats(): Promise<void> {
    const repo = this.dataSource.getRepository(AllowedChat);
    const rows = await repo.find({
      where: { integrationKind: 'telegram' },
      order: { id: 'ASC' },
    });
    if (rows.length === 0) return;
    this.edit((document) => {
      for (const row of rows) allowChat(document, row.chatKey, row.title);
    });
    await inTransaction(this.dataSource, (manager) =>
      manager.getRepository(AllowedChat).delete(rows.map((row) => row.id)),
    );
    this.logger.log(
      `Moved ${rows.length} allowed chat${rows.length === 1 ? '' : 's'} into ${this.options.file}`,
    );
  }

  /**
   * The data folder, checked. A workspace's default `data/` is created
   * when missing; any other folder must exist, or startup stops. A legacy
   * data directory only warns, as it did before `config.yaml`.
   */
  private async checkDataFolder(): Promise<string | null> {
    const { workspace, base, file } = this.options;
    const folder = resolveDataFolder(this.config, base, workspace !== null);
    if (folder === null) return null;
    if (workspace !== null && folder === join(workspace, DEFAULT_DATA_FOLDER)) {
      mkdirSync(folder, { recursive: true });
    }
    try {
      return await validateWorkingDirectory(folder);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (workspace === null) {
        this.logger.warn(`data in ${file}: ${reason}`);
        return folder;
      }
      throw new ConfigError(`Invalid ${file}:\n  data: ${reason}`);
    }
  }
}
