import { Injectable } from '@nestjs/common';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NotFoundError } from '../common/errors.js';
import { guideFile } from '../guide/agent-guide.js';
import type { Provider, ProviderDefaults } from '../config/provider-options.js';
import type { PermissionMode } from '../config/tool-policy.js';
import { slugify } from '../config/slug.js';
import { shownPath } from '../system-files/note-paths.js';
import {
  buildSnapshot,
  channelIdFor,
  type ChannelNote,
  DEFAULT_NOTE,
  DEFAULT_NOTE_FILE,
  defaultsNote,
  isResolved,
  type NoteMatch,
  noteFor,
  type ResolvedWorkflow,
  type SystemSnapshot,
} from '../system-files/snapshot.js';
import { SystemNotes } from './system-notes.service.js';

/** Installation defaults that turns and Pero's own limits follow. */
export interface Defaults {
  provider: Provider;
  /** Each provider's model and effort; null lets the provider choose. */
  providerDefaults: ProviderDefaults;
  permissions: PermissionMode;
  /** IANA time zone. */
  timezone: string;
  /** How many latest messages a fresh Session starts with; 0 carries none. */
  historyCarryover: number;
  /** Days of message history kept; null keeps all of it. */
  historyRetentionDays: number | null;
  /** Upper bound on Workflow Runs executing at once. */
  maxConcurrentRuns: number;
  /** The owner's notes and files, which every turn's instructions name. */
  dataFolder: string;
  /** The notes themselves, which every turn's instructions name. */
  systemFolder: string;
  /** The guide to the notes in `.pero/`, which every turn's instructions name. */
  guideFile: string;
  /** `Persona.md`'s text, which every turn's instructions start with. */
  persona: string | null;
  /** `Instructions.md`'s text, which follows the persona. */
  instructions: string | null;
}

/** A Channel as routing sees it. */
export interface RouteQuery {
  /** `<integration>:<address>`, as a note's `channel-id` names it. */
  channelId: string;
  /** A group's General topic, a group without topics, or a direct chat. */
  primary: boolean;
  /** The topic's title; null while Pero hasn't seen it. */
  title: string | null;
}

/**
 * A Channel, by its key, as routing sees it. A primary Channel's key is
 * its chat's; a topic's adds the topic's ID after a colon.
 */
export function routeQuery(channel: {
  integrationKind: string;
  externalKey: string;
  title: string | null;
}): RouteQuery {
  return {
    channelId: channelIdFor(channel.integrationKind, channel.externalKey),
    primary: !channel.externalKey.includes(':'),
    title: channel.title,
  };
}

/**
 * Why Pero doesn't answer in a Channel. Files are notes' paths as the
 * owner reads them: inside the workspace, relative to it.
 */
export type Unanswered =
  /** Its note sets `enabled: false`; `file` is the note. */
  | { kind: 'disabled'; file: string }
  /** Only notes that have errors and never loaded, in `files`, are for it. */
  | { kind: 'unloaded'; files: string[] }
  /** Pero hasn't seen the topic's title yet, so no note can match it. */
  | { kind: 'untitled' };

/**
 * How Pero answers in a Channel now: with its note's settings, or not at
 * all and why. `match` says whether the note exists, so Pero can write or
 * bind it.
 */
export type Route =
  | { kind: 'answered'; note: ChannelNote; match: NoteMatch['kind'] }
  | { kind: 'unanswered'; reason: Unanswered };

/**
 * What Pero is configured to run: the defaults, the Channel notes, and the
 * Workflows, from the workspace's notes as the current snapshot holds
 * them, so an edit applies from the next turn or run. Read-only; the
 * owner's edits of notes change the definitions, and `onChange` says when
 * they have. Runtime code reads definitions only through this.
 */
@Injectable()
export class Definitions {
  constructor(private readonly notes: SystemNotes) {}

  defaults(): Defaults {
    const { snapshot, dataFolder, systemFolder, workspace } = this.current();
    return {
      provider: snapshot.defaults.provider,
      providerDefaults: snapshot.defaults.providerDefaults,
      permissions: snapshot.defaults.permissions,
      timezone: snapshot.defaults.timezone,
      historyCarryover: snapshot.defaults.historyCarryover,
      historyRetentionDays: snapshot.defaults.historyRetentionDays,
      maxConcurrentRuns: snapshot.defaults.maxConcurrentRuns,
      dataFolder,
      systemFolder,
      guideFile: guideFile(workspace),
      persona: snapshot.persona,
      instructions: snapshot.instructions,
    };
  }

  /**
   * The settings of the Channel note named `name`, in any case: the note's,
   * or `Pero.md`'s defaults while no note of that name loaded.
   */
  channelNote(name: string): ChannelNote {
    const { snapshot, workspace } = this.current();
    const key = slugify(name) ?? name.toLowerCase();
    return (
      snapshot.channelNotes.get(key) ??
      defaultsNote(
        key,
        key === DEFAULT_NOTE ? 'Default' : name,
        snapshot.defaults,
        workspace,
      )
    );
  }

  /** Every Channel note that loaded, by name. */
  channelNotes(): ChannelNote[] {
    const { snapshot } = this.current();
    return [...snapshot.channelNotes.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }

  /**
   * How Pero answers in `channel` now: a primary Channel with `Default.md`,
   * a topic with the note bound to it, or else the note named as its
   * title; with `Pero.md`'s defaults while it has none.
   */
  route(channel: RouteQuery): Route {
    const { snapshot, systemFolder, workspace } = this.current();
    const shown = (file: string) =>
      shownPath(workspace, join(systemFolder, file));
    const unanswered = (reason: Unanswered): Route => ({
      kind: 'unanswered',
      reason,
    });
    const match = noteFor(snapshot, channel);
    let note: ChannelNote;
    switch (match.kind) {
      case 'untitled':
        return unanswered({ kind: 'untitled' });
      case 'unloaded':
        return unanswered({ kind: 'unloaded', files: match.files.map(shown) });
      case 'note':
      case 'bindable':
        note = match.note;
        break;
      case 'none': {
        const title = channel.primary
          ? 'Default'
          : (channel.title?.trim() ?? '');
        note = defaultsNote(
          match.name ?? `channel-${channel.channelId}`,
          title,
          snapshot.defaults,
          workspace,
        );
        break;
      }
    }
    if (!note.enabled) {
      return unanswered({ kind: 'disabled', file: shown(note.file!) });
    }
    return { kind: 'answered', note, match: match.kind };
  }

  /** `Default.md` as the owner reads its path. */
  defaultNoteFile(): string {
    const { systemFolder, workspace } = this.current();
    return shownPath(workspace, join(systemFolder, DEFAULT_NOTE_FILE));
  }

  /**
   * The Workflow named `name`, in any case; null if none. Its Channel
   * references always resolve here, since the notes are read with the
   * Channels Pero has seen.
   */
  workflow(name: string): ResolvedWorkflow | null {
    const { snapshot } = this.current();
    const workflow = snapshot.workflows.get(name.toLowerCase());
    return workflow !== undefined && isResolved(workflow) ? workflow : null;
  }

  /** Every Workflow, by name. */
  workflows(): ResolvedWorkflow[] {
    const { snapshot } = this.current();
    return [...snapshot.workflows.values()]
      .filter(isResolved)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * Calls `listener` after the definitions may have changed; returns a
   * function that stops the calls.
   */
  onChange(listener: () => void): () => void {
    return this.notes.onChange(() => listener());
  }

  /**
   * The snapshot in use, and the data folder. Before the notes could be
   * read at all, as when the system folder is unreadable, there are no
   * Channel notes and every default is Pero's own.
   */
  private current(): {
    snapshot: SystemSnapshot;
    dataFolder: string;
    systemFolder: string;
    workspace: string;
  } {
    const snapshot = this.notes.snapshot();
    const folders = this.notes.folders();
    return {
      snapshot:
        snapshot ??
        buildSnapshot([], {
          workspace: folders.workspace,
          homeDir: homedir(),
          hostTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      dataFolder: folders.dataFolder,
      systemFolder: folders.systemFolder,
      workspace: folders.workspace,
    };
  }
}

/** The Workflow named `name`; `NotFoundError` if none. */
export function requireWorkflow(
  definitions: Definitions,
  name: string,
): ResolvedWorkflow {
  const workflow = definitions.workflow(name);
  if (workflow === null) throw new NotFoundError(`No Workflow named ${name}`);
  return workflow;
}
