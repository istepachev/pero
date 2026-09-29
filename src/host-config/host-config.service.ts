import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
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
  readHostConfig,
  resolveDataFolder,
  setDataFolder,
} from '../config/host-config.js';
import { validateWorkingDirectory } from '../config/working-directory.js';
import { AllowedChat } from '../persistence/entities/allowed-chat.entity.js';
import {
  SETTINGS_ID,
  Settings,
} from '../persistence/entities/settings.entity.js';
import { inTransaction } from '../persistence/transaction.js';

export const HOST_CONFIG_OPTIONS = Symbol('HOST_CONFIG_OPTIONS');

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
 * to the file, keeping its comments.
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

  constructor(
    @Inject(HOST_CONFIG_OPTIONS) private readonly options: HostConfigOptions,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    const settings = this.dataSource.getRepository(Settings);
    const current = await settings.findOneByOrFail({ id: SETTINGS_ID });
    this.config =
      readHostConfig(this.options.file) ??
      this.create(current.defaultWorkingDirectory);
    await this.importAllowedChats();

    const folder = await this.checkDataFolder();
    if (folder !== null && folder !== current.defaultWorkingDirectory) {
      await settings.update(SETTINGS_ID, { defaultWorkingDirectory: folder });
      this.logger.log(
        `Data folder is ${folder}` +
          (current.defaultWorkingDirectory === null
            ? ''
            : `, was ${current.defaultWorkingDirectory}`),
      );
    }
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

  /** Writes `folder` (absolute) as the data folder. */
  setDataFolder(folder: string): void {
    const value = dataFolderValue(folder, this.options.workspace);
    this.edit((document) => setDataFolder(document, value));
  }

  private find(chatKey: string): HostAllowedChat | undefined {
    return this.config.allowedChats.find((chat) => chat.chatKey === chatKey);
  }

  private edit(change: Parameters<typeof editHostConfig>[1]): void {
    this.config = editHostConfig(this.options.file, change, () =>
      this.template(null),
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
