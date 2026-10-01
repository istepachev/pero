import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { homedir } from 'node:os';
import type { DataSource } from 'typeorm';
import { ComponentHealth } from '../health/component-health.js';
import { HostConfigService } from '../host-config/host-config.service.js';
import { type BrokenNote, SettingsReloader } from '../settings-files/reload.js';
import type { SettingsError } from '../settings-files/settings-error.js';
import type { SettingsSnapshot } from '../settings-files/snapshot.js';
import { allowedChannels } from './allowed-channels.js';
import { channelTopicLookup } from './channel-topics.js';

/** How often the settings folder is scanned for edits. */
export const SETTINGS_NOTES_TICK_MS = 10_000;

/** The health component the notes report as. */
export const SETTINGS_COMPONENT = 'settings';

/** Where the notes are, and the folders they are read against. */
export interface SettingsFolders {
  workspace: string;
  dataFolder: string;
  settingsFolder: string;
}

/** What changed in a new snapshot. */
export interface SettingsChange {
  snapshot: SettingsSnapshot;
  /** The notes that changed, appeared, or were removed, by path. */
  files: readonly string[];
}

/**
 * The notes in the settings folder: `Pero.md`, Agents, and Workflows, held
 * as one snapshot and rescanned every 10 seconds. Edits made anywhere
 * (Obsidian, Syncthing, `git pull`, an Agent) apply the same way. A broken
 * note is reported in the log and the `settings` component, and its last
 * good version stays in use while Pero runs.
 *
 * Workflow references to topics resolve against the Channels Pero has
 * seen in the allowed chats, looked up on each scan: when those change,
 * the snapshot is built again, though no note changed.
 *
 * `FileDefinitions` serves the definitions from the snapshot.
 */
@Injectable()
export class SettingsNotes
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('Settings');
  private reloader: SettingsReloader | null = null;
  /** The first load, started by whichever needs the notes first. */
  private loaded: Promise<void> | null = null;
  private readonly listeners = new Set<(change: SettingsChange) => void>();
  /** The rescan under way, if any. */
  private current: Promise<void> | null = null;
  private stopping = false;
  /** The Channels references last resolved against, as JSON. */
  private topics: string | null = null;

  constructor(
    private readonly health: ComponentHealth,
    private readonly hostConfig: HostConfigService,
    // Absent only in tests without a database: references then are
    // checked for syntax only, as in pero check without Pero.
    @Optional() @InjectDataSource() private readonly dataSource?: DataSource,
  ) {}

  /**
   * Loads the notes before the daemon answers its control socket, if
   * nothing needed them earlier.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.ready();
  }

  /**
   * The snapshot in use, loading the notes the first time: startup work,
   * such as recovering Workflow runs, may need them before
   * `onApplicationBootstrap`. `config.yaml` has been read by then, its
   * module being global. Null when the settings folder can't be read.
   */
  async ready(): Promise<SettingsSnapshot | null> {
    await (this.loaded ??= this.load());
    return this.snapshot();
  }

  private async load(): Promise<void> {
    const folders = this.folders();
    this.reloader = new SettingsReloader(folders.settingsFolder, {
      workspace: folders.workspace,
      dataFolder: folders.dataFolder,
      homeDir: homedir(),
      hostTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    await this.rescan();
  }

  /**
   * The workspace, data folder, and settings folder the notes are read
   * from, absolute: as they were at startup.
   */
  folders(): SettingsFolders {
    return this.hostConfig.folders();
  }

  /** Lets a rescan under way finish. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.current;
  }

  @Interval('settings-notes', SETTINGS_NOTES_TICK_MS)
  onInterval(): void {
    void this.rescan();
  }

  /** The snapshot in use; null until the notes could be read. */
  snapshot(): SettingsSnapshot | null {
    return this.reloader?.current() ?? null;
  }

  /**
   * The notes the snapshot in use reports errors for, each with the
   * version read.
   */
  broken(): BrokenNote[] {
    return this.reloader?.broken() ?? [];
  }

  /**
   * Calls `listener` each time the snapshot changes; returns a function
   * that stops the calls.
   */
  onChange(listener: (change: SettingsChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Scans the settings folder once; one scan at a time, and never throws. */
  rescan(): Promise<void> {
    if (this.reloader === null || this.stopping) return Promise.resolve();
    this.current ??= this.reload(this.reloader)
      .catch((error: unknown) => {
        this.logger.error(
          `Could not read the settings in ${this.folders().settingsFolder}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.current = null;
      });
    return this.current;
  }

  /**
   * Scans the settings folder once more after any scan under way, so a
   * note Pero just wrote is in the snapshot when this resolves.
   */
  async refresh(): Promise<void> {
    await this.current;
    await this.rescan();
  }

  private async reload(reloader: SettingsReloader): Promise<void> {
    const first = reloader.current() === null;
    await this.lookUpTopics(reloader);
    const reload = await reloader.rescan();
    if (reload === null) return;
    const { snapshot, changed, appeared, fixed } = reload;
    if (first) {
      this.logger.log(
        `Loaded ${count(snapshot.agents.size, 'Agent')} and ${count(snapshot.workflows.size, 'Workflow')} from ${this.folders().settingsFolder}`,
      );
    } else if (changed.length > 0) {
      this.logger.log(`Settings notes changed: ${changed.join(', ')}`);
    }
    for (const error of appeared) this.logger.warn(describe(error));
    for (const error of fixed) this.logger.log(`Fixed: ${describe(error)}`);
    this.reportHealth(snapshot);
    for (const listener of this.listeners) {
      try {
        listener({ snapshot, files: changed });
      } catch (error) {
        this.logger.error(
          `A settings listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Gives `reloader` the Channels of the allowed chats to resolve
   * references against, when they changed since it last had them. Should
   * they fail to load, the ones it has stay.
   */
  private async lookUpTopics(reloader: SettingsReloader): Promise<void> {
    if (this.dataSource === undefined) return;
    let channels;
    try {
      channels = await allowedChannels(
        this.dataSource,
        this.hostConfig.allowedChats(),
      );
    } catch (error) {
      this.logger.error(
        `Could not read the topics Workflow notes name: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const topics = JSON.stringify(channels);
    if (topics === this.topics) return;
    this.topics = topics;
    reloader.setTopics(channelTopicLookup(channels));
  }

  /** `settings`: `ok`, or how many notes have errors. */
  private reportHealth(snapshot: SettingsSnapshot): void {
    const broken = new Set(snapshot.errors.map((error) => error.file)).size;
    if (broken === 0) {
      this.health.report(SETTINGS_COMPONENT, 'ok');
      return;
    }
    this.health.report(
      SETTINGS_COMPONENT,
      'degraded',
      `${broken} ${broken === 1 ? 'note has' : 'notes have'} errors; run pero check`,
    );
  }
}

function describe({ file, property, message }: SettingsError): string {
  return `${file}: ${property === null ? '' : `${property}: `}${message}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
