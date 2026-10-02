import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { type DataSource, In } from 'typeorm';
import { ChannelSender } from '../channels/channel-sender.js';
import type { HostAllowedChat } from '../config/host-config.js';
import { HostConfigService } from '../host-config/host-config.service.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { shownPath } from '../system-files/note-paths.js';
import type { BrokenNote } from '../system-files/reload.js';
import {
  type NoteRead,
  readNote,
  type SystemSnapshot,
  type TopicLookup,
} from '../system-files/snapshot.js';
import { allowedChannels } from '../system/allowed-channels.js';
import {
  channelTopicLookup,
  type KnownChannel,
} from '../system/channel-topics.js';
import { SystemNotes } from '../system/system-notes.service.js';

/** A broken note to report, with what the snapshot makes of it. */
export interface BrokenNoteReport {
  note: BrokenNote;
  /** The note as read, or null when it isn't a note Pero knows. */
  read: NoteRead | null;
  /** Whether a version of it is in the snapshot. */
  inUse: boolean;
}

/**
 * Posts to Telegram when a system note becomes broken, since it is
 * often edited on a phone, far from `pero check` and the log: one message
 * per broken version, keyed by its content, naming the note and each error,
 * and what Pero uses meanwhile. It goes to the Channels the note relates to
 * (an Agent's topics, a Workflow's `channel`), else to the main Agent's
 * primary Channel, and isn't recorded in Channel history.
 *
 * Notes broken at startup are only logged, as before: no edit is waiting
 * for an answer. A fixed note is logged by `SystemNotes` and forgotten
 * here, so breaking it again the same way posts again. Sending is best
 * effort: a failed send is logged, not retried.
 */
@Injectable()
export class BrokenNoteReports
  implements OnModuleInit, BeforeApplicationShutdown
{
  private readonly logger = new Logger('System');
  /** The broken versions known, reported or not, by `versionKey`. */
  private known = new Set<string>();
  /** The reports under way, one after another. */
  private queue: Promise<void> = Promise.resolve();
  private stopListening: (() => void) | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly notes: SystemNotes,
    private readonly sender: ChannelSender,
    private readonly hostConfig: HostConfigService,
  ) {}

  /** Takes the notes broken at startup as known, then follows each change. */
  onModuleInit(): void {
    this.known = new Set(this.notes.broken().map(versionKey));
    this.stopListening = this.notes.onChange(({ snapshot }) =>
      this.changed(snapshot),
    );
  }

  /** Lets the reports under way finish. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopListening?.();
    await this.idle();
  }

  /** Resolves once the reports under way have been sent. */
  idle(): Promise<void> {
    return this.queue;
  }

  private changed(snapshot: SystemSnapshot): void {
    const broken = this.notes.broken();
    const fresh = broken.filter((note) => !this.known.has(versionKey(note)));
    this.known = new Set(broken.map(versionKey));
    if (fresh.length === 0) return;
    this.queue = this.queue
      .then(() => this.report(fresh, snapshot))
      .catch((error: unknown) => {
        this.logger.error(
          `Could not report the errors in ${fresh.map((note) => note.file).join(', ')} in Telegram: ${describe(error)}`,
        );
      });
  }

  /** Posts about `broken`, one message per Channel. */
  private async report(
    broken: readonly BrokenNote[],
    snapshot: SystemSnapshot,
  ): Promise<void> {
    const folders = this.notes.folders();
    const allowed = this.hostConfig.allowedChats();
    const channels = await allowedChannels(this.dataSource, allowed);
    const lookup = channelTopicLookup(channels);
    const shown = (file: string) =>
      shownPath(folders.workspace, join(folders.systemFolder, file));

    const messages = new Map<number, string[]>();
    for (const note of broken) {
      const report = brokenNoteReport(note, snapshot);
      const related = relatedChannels(report, snapshot, channels, lookup);
      const targets =
        related.length > 0 ? related : primaryChannel(allowed, channels);
      if (targets.length === 0) {
        this.logger.warn(
          `No Channel to report the errors in ${note.file} in: Pero has seen none it relates to, nor a primary Channel`,
        );
        continue;
      }
      const text = brokenNoteMessage(report, shown(note.file));
      for (const id of targets) {
        messages.set(id, [...(messages.get(id) ?? []), text]);
      }
    }
    if (messages.size === 0) return;

    const rows = await this.dataSource
      .getRepository(Channel)
      .findBy({ id: In([...messages.keys()]) });
    for (const channel of rows) {
      const texts = messages.get(channel.id)!;
      try {
        await this.sender.send(channel.integrationKind, channel.address, {
          text: texts.join('\n\n'),
        });
        this.logger.log(
          `Reported ${texts.length === 1 ? 'a broken note' : `${texts.length} broken notes`} in Channel ${channel.id}`,
        );
      } catch (error) {
        this.logger.warn(
          `Could not report broken notes in Channel ${channel.id}: ${describe(error)}`,
        );
      }
    }
  }
}

/** `note` read, and whether a version of it is in `snapshot`. */
export function brokenNoteReport(
  note: BrokenNote,
  snapshot: SystemSnapshot,
): BrokenNoteReport {
  const read = readNote(note.file, note.text).note;
  const inUse = (definitions: ReadonlyMap<string, { file: string }>) =>
    [...definitions.values()].some(({ file }) => file === note.file);
  switch (read?.kind) {
    case 'pero':
      // Its own defaults stand in for a Pero.md left out.
      return { note, read, inUse: note.fallback || read.read.result.ok };
    case 'agent':
      return { note, read, inUse: inUse(snapshot.agents) };
    case 'workflow':
      return { note, read, inUse: inUse(snapshot.workflows) };
    default:
      return { note, read: null, inUse: false };
  }
}

/**
 * The message about a broken note shown as `path`: each error, then what
 * Pero uses meanwhile.
 */
export function brokenNoteMessage(
  { note, read, inUse }: BrokenNoteReport,
  path: string,
): string {
  const lines = [`Errors in ${path}:`];
  for (const { property, message } of note.errors) {
    lines.push(property === null ? message : `${property}: ${message}`);
  }
  if (!inUse) {
    lines.push(
      read?.kind === 'pero'
        ? "Pero's own defaults are used until it's fixed."
        : "It's left out until it's fixed.",
    );
  } else if (note.fallback) {
    lines.push('Its last good version stays in use.');
  }
  return lines.join('\n');
}

/**
 * The Channels a broken note relates to, by ID: the topic an Agent
 * claims, or the Channels a Workflow posts to, as the broken version and
 * the version in use name them. Only Channels Pero has seen count.
 */
function relatedChannels(
  { note, read }: BrokenNoteReport,
  snapshot: SystemSnapshot,
  channels: readonly KnownChannel[],
  lookup: TopicLookup,
): number[] {
  const ids = new Set<number>();
  switch (read?.kind) {
    case 'agent': {
      const titles = listed(read.read.note?.properties.topic);
      for (const agent of snapshot.agents.values()) {
        if (agent.file === note.file && agent.topic !== null) {
          titles.push(agent.topic);
        }
      }
      const keys = new Set(
        titles.map((title) => String(title).trim().toLowerCase()),
      );
      for (const channel of channels) {
        const title = channel.title?.trim().toLowerCase();
        if (channel.key.includes(':') && title !== undefined && keys.has(title))
          ids.add(channel.id);
      }
      break;
    }
    case 'workflow': {
      for (const ref of listed(read.read.note?.properties.channel)) {
        const found = lookup.resolve(ref);
        if (found.kind === 'ok') ids.add(found.channel.id);
      }
      for (const workflow of snapshot.workflows.values()) {
        if (workflow.file !== note.file) continue;
        for (const id of workflow.resolved?.targets ?? []) ids.add(id);
      }
      break;
    }
  }
  return [...ids];
}

/**
 * The main Agent's primary Channel: that of the first chat in
 * `config.yaml` whose primary Channel Pero has seen; none if none.
 */
function primaryChannel(
  allowed: readonly HostAllowedChat[],
  channels: readonly KnownChannel[],
): number[] {
  for (const chat of allowed) {
    const primary = channels.find((channel) => channel.key === chat.chatKey);
    if (primary !== undefined) return [primary.id];
  }
  return [];
}

/** The titles or IDs a property lists, whether or not it is valid. */
function listed(value: unknown): (string | number)[] {
  return (Array.isArray(value) ? value : [value]).filter(
    (item): item is string | number =>
      (typeof item === 'string' && item.trim() !== '') ||
      Number.isInteger(item),
  );
}

/** A broken version of a note: its file and a hash of its text. */
function versionKey({ file, text }: BrokenNote): string {
  return `${file}\n${createHash('sha256').update(text).digest('hex')}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
