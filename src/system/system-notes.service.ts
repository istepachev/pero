import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import type { DataSource } from 'typeorm';
import { writeSystemSkeleton } from '../config/workspace-skeleton.js';
import { ComponentHealth } from '../health/component-health.js';
import { HostConfigService } from '../host-config/host-config.service.js';
import { type BrokenNote, SystemReloader } from '../system-files/reload.js';
import type { NoteError } from '../system-files/note-error.js';
import type { SystemSnapshot } from '../system-files/snapshot.js';
import { allowedChannels } from './allowed-channels.js';
import { channelTopicLookup } from './channel-topics.js';

/** How often the system folder is scanned for edits. */
export const SYSTEM_NOTES_TICK_MS = 10_000;

/** The health component the notes report as. */
export const SYSTEM_COMPONENT = 'system';

/** Where the notes are, and the folders they are read against. */
export interface SystemFolders {
  workspace: string;
  dataFolder: string;
  systemFolder: string;
}

/** What changed in a new snapshot. */
export interface SystemChange {
  snapshot: SystemSnapshot;
  /** The notes that changed, appeared, or were removed, by path. */
  files: readonly string[];
}

/**
 * The notes in the system folder: `Pero.md`, Agents, and Workflows, held
 * as one snapshot and rescanned every 10 seconds. Edits made anywhere
 * (Obsidian, Syncthing, `git pull`, an Agent) apply the same way. A broken
 * note is reported in the log and the `system` component, and its last
 * good version stays in use while Pero runs.
 *
 * Workflow references to topics resolve against the Channels Pero has
 * seen in the allowed chats, looked up on each scan: when those change,
 * the snapshot is built again, though no note changed.
 *
 * `Definitions` serves the definitions from the snapshot.
 */
@Injectable()
export class SystemNotes implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger('System');
  private reloader: SystemReloader | null = null;
  private readonly listeners = new Set<(change: SystemChange) => void>();
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
   * Loads the notes. The modules that read them import this one, so Nest
   * calls this before their own startup hooks, and nothing reads the
   * snapshot before it is loaded. `config.yaml` has been read by then, its
   * module being global. A system folder that is missing, as when it was
   * deleted, is written as `pero init` writes it.
   */
  async onModuleInit(): Promise<void> {
    const folders = this.folders();
    this.createIfMissing(folders.systemFolder);
    this.reloader = new SystemReloader(folders.systemFolder, {
      workspace: folders.workspace,
      homeDir: homedir(),
      hostTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    await this.rescan();
  }

  /**
   * Writes the skeleton in `folder` when nothing is there; a folder that
   * can't be written is left to the scan to report.
   */
  private createIfMissing(folder: string): void {
    try {
      lstatSync(folder);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
    try {
      writeSystemSkeleton(folder);
      this.logger.log(
        `Created the system folder ${folder} with Pero.md, Agents/Main.md, and Workflows/`,
      );
    } catch (error) {
      this.logger.error(
        `Could not create the system folder ${folder}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The workspace, data folder, and system folder the notes are read
   * from, absolute: as they were at startup.
   */
  folders(): SystemFolders {
    return this.hostConfig.folders();
  }

  /** Lets a rescan under way finish. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.current;
  }

  @Interval('system-notes', SYSTEM_NOTES_TICK_MS)
  onInterval(): void {
    void this.rescan();
  }

  /**
   * The snapshot in use; null while the notes couldn't be read, as when
   * the system folder is unreadable.
   */
  snapshot(): SystemSnapshot | null {
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
  onChange(listener: (change: SystemChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Scans the system folder once; one scan at a time, and never throws. */
  rescan(): Promise<void> {
    if (this.reloader === null || this.stopping) return Promise.resolve();
    this.current ??= this.reload(this.reloader)
      .catch((error: unknown) => {
        this.logger.error(
          `Could not read the system folder ${this.folders().systemFolder}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.current = null;
      });
    return this.current;
  }

  /**
   * Scans the system folder once more after any scan under way, so a
   * note Pero just wrote is in the snapshot when this resolves.
   */
  async refresh(): Promise<void> {
    await this.current;
    await this.rescan();
  }

  private async reload(reloader: SystemReloader): Promise<void> {
    const first = reloader.current() === null;
    await this.lookUpTopics(reloader);
    const reload = await reloader.rescan();
    if (reload === null) return;
    const { snapshot, changed, appeared, fixed } = reload;
    if (first) {
      this.logger.log(
        `Loaded ${count(snapshot.agents.size, 'Agent')} and ${count(snapshot.workflows.size, 'Workflow')} from ${this.folders().systemFolder}`,
      );
    } else if (changed.length > 0) {
      this.logger.log(`System notes changed: ${changed.join(', ')}`);
    }
    for (const error of appeared) this.logger.warn(describe(error));
    for (const error of fixed) this.logger.log(`Fixed: ${describe(error)}`);
    this.reportHealth(snapshot);
    for (const listener of this.listeners) {
      try {
        listener({ snapshot, files: changed });
      } catch (error) {
        this.logger.error(
          `A system notes listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Gives `reloader` the Channels of the allowed chats to resolve
   * references against, when they changed since it last had them. Should
   * they fail to load, the ones it has stay.
   */
  private async lookUpTopics(reloader: SystemReloader): Promise<void> {
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

  /** `system`: `ok`, or how many notes have errors. */
  private reportHealth(snapshot: SystemSnapshot): void {
    const broken = new Set(snapshot.errors.map((error) => error.file)).size;
    if (broken === 0) {
      this.health.report(SYSTEM_COMPONENT, 'ok');
      return;
    }
    this.health.report(
      SYSTEM_COMPONENT,
      'degraded',
      `${broken} ${broken === 1 ? 'note has' : 'notes have'} errors; run pero check`,
    );
  }
}

function describe({ file, property, message }: NoteError): string {
  return `${file}: ${property === null ? '' : `${property}: `}${message}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
