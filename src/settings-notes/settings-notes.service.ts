import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { homedir } from 'node:os';
import { ComponentHealth } from '../health/component-health.js';
import { HostConfigService } from '../host-config/host-config.service.js';
import { SettingsReloader } from '../settings-files/reload.js';
import type { SettingsError } from '../settings-files/settings-error.js';
import type { SettingsSnapshot } from '../settings-files/snapshot.js';

/** How often the settings folder is scanned for edits. */
export const SETTINGS_NOTES_TICK_MS = 10_000;

/** The health component the notes report as. */
export const SETTINGS_COMPONENT = 'settings';

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
 * Nothing reads the snapshot yet. In a legacy data directory there are no
 * notes, and this does nothing.
 */
@Injectable()
export class SettingsNotes
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('Settings');
  private reloader: SettingsReloader | null = null;
  private settingsFolder: string | null = null;
  private readonly listeners = new Set<(change: SettingsChange) => void>();
  /** The rescan under way, if any. */
  private current: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly hostConfig: HostConfigService,
    private readonly health: ComponentHealth,
  ) {}

  /**
   * Loads the notes once `config.yaml` has been read, before the daemon
   * answers its control socket.
   */
  async onApplicationBootstrap(): Promise<void> {
    const folders = this.hostConfig.folders();
    if (folders === null) return;
    this.settingsFolder = folders.settingsFolder;
    this.reloader = new SettingsReloader(folders.settingsFolder, {
      workspace: folders.workspace,
      dataFolder: folders.dataFolder,
      homeDir: homedir(),
      hostTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    await this.rescan();
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

  /** The snapshot in use; null in a legacy data directory. */
  snapshot(): SettingsSnapshot | null {
    return this.reloader?.current() ?? null;
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
          `Could not read the settings in ${this.settingsFolder}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.current = null;
      });
    return this.current;
  }

  private async reload(reloader: SettingsReloader): Promise<void> {
    const first = reloader.current() === null;
    const reload = await reloader.rescan();
    if (reload === null) return;
    const { snapshot, changed, appeared, fixed } = reload;
    if (first) {
      this.logger.log(
        `Loaded ${count(snapshot.agents.size, 'Agent')} and ${count(snapshot.workflows.size, 'Workflow')} from ${this.settingsFolder}`,
      );
    } else {
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
