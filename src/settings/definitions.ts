import { Injectable } from '@nestjs/common';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import { NotFoundError } from '../common/errors.js';
import type { Provider, ProviderDefaults } from '../config/provider-options.js';
import type { PermissionMode } from '../config/tool-policy.js';
import { shownPath } from '../settings-files/note-paths.js';
import { agentNoteFor } from '../settings-files/note-writer.js';
import { NOTE_FOLDERS } from '../settings-files/note-files.js';
import {
  type Agent,
  buildSnapshot,
  isResolved,
  type ResolvedWorkflow,
  type SettingsSnapshot,
  topicClaim,
} from '../settings-files/snapshot.js';
import { SettingsNotes } from './settings-notes.service.js';

/** Installation defaults that Agents and Pero's own limits follow. */
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
  /** The owner's notes and files, which every Agent's instructions name. */
  dataFolder: string;
  /** Placed before each opted-in Agent's own instructions; null for none. */
  sharedInstructions: string | null;
}

/** A Channel as routing sees it. */
export interface RouteQuery {
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
  externalKey: string;
  title: string | null;
}): RouteQuery {
  return {
    primary: !channel.externalKey.includes(':'),
    title: channel.title,
  };
}

/**
 * Why no Agent answers in a Channel. Files are notes' paths as the owner
 * reads them: inside the workspace, relative to it.
 */
export type Unanswered =
  /** Its Agent is disabled; `file` is its note. */
  | { kind: 'disabled'; agent: string; file: string }
  /** Several Agents' notes, in `files`, claim the topic. */
  | { kind: 'conflict'; title: string; files: string[] }
  /** Only notes that have errors and never loaded, in `files`, claim it. */
  | { kind: 'unloaded'; title: string; files: string[] }
  /** No Agent claims the topic; `note` is one that could. */
  | { kind: 'unclaimed'; title: string; note: string }
  /** Pero hasn't seen the topic's title yet, so nothing can claim it. */
  | { kind: 'untitled' }
  /** No note defines the main Agent; `note` is the one to add. */
  | { kind: 'no-main-agent'; agent: string; note: string };

/** Who answers in a Channel now: an enabled Agent, or no one and why. */
export type Route =
  { kind: 'agent'; agent: Agent } | { kind: 'unanswered'; reason: Unanswered };

/**
 * What Pero is configured to run: the defaults, the Agents, and the
 * Workflows, from the workspace's notes as the current snapshot holds
 * them, so an edit applies from the next turn or run. Read-only; the
 * owner's edits of notes change the definitions, and `onChange` says when
 * they have. Runtime code reads definitions only through this.
 */
@Injectable()
export class Definitions {
  constructor(private readonly notes: SettingsNotes) {}

  defaults(): Defaults {
    const { snapshot, dataFolder } = this.current();
    return {
      provider: snapshot.defaults.provider,
      providerDefaults: snapshot.defaults.providerDefaults,
      permissions: snapshot.defaults.permissions,
      timezone: snapshot.defaults.timezone,
      historyCarryover: snapshot.defaults.historyCarryover,
      historyRetentionDays: snapshot.defaults.historyRetentionDays,
      maxConcurrentRuns: snapshot.defaults.maxConcurrentRuns,
      dataFolder,
      sharedInstructions: snapshot.sharedInstructions,
    };
  }

  /** The Agent named `name`, in any case; null if none. */
  agent(name: string): Agent | null {
    const { snapshot } = this.current();
    return snapshot.agents.get(name.toLowerCase()) ?? null;
  }

  /** Every Agent, by name. */
  agents(): Agent[] {
    const { snapshot } = this.current();
    return [...snapshot.agents.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }

  /** The Agent primary Channels get; null while no note defines it. */
  mainAgent(): Agent | null {
    const { snapshot } = this.current();
    return snapshot.agents.get(snapshot.mainAgent) ?? null;
  }

  /** The name of the Agent primary Channels get, even while it is not defined. */
  mainAgentName(): string {
    return this.current().snapshot.mainAgent;
  }

  /**
   * Who answers in `channel` now. A primary Channel gets the main Agent,
   * and a topic the Agent whose `topics` claims its title; `new-topics`
   * decides an unclaimed one.
   */
  route(channel: RouteQuery): Route {
    const { snapshot, settingsFolder, workspace } = this.current();
    const shown = (file: string) =>
      shownPath(workspace, join(settingsFolder, file));
    const unanswered = (reason: Unanswered): Route => ({
      kind: 'unanswered',
      reason,
    });
    const answered = (name: string): Route => {
      const agent = snapshot.agents.get(name);
      if (agent === undefined) {
        return unanswered({
          kind: 'no-main-agent',
          agent: name,
          note: shown(agentNoteFor(name)),
        });
      }
      if (!agent.enabled) {
        return unanswered({
          kind: 'disabled',
          agent: agent.name,
          file: shown(agent.file),
        });
      }
      return { kind: 'agent', agent };
    };
    const toMain = snapshot.defaults.newTopics === 'main-agent';

    if (channel.primary) return answered(snapshot.mainAgent);
    const title = channel.title?.trim() ?? '';
    if (title === '') {
      return toMain
        ? answered(snapshot.mainAgent)
        : unanswered({ kind: 'untitled' });
    }
    const claim = topicClaim(snapshot, title);
    switch (claim.kind) {
      case 'agent':
        return answered(claim.agent);
      case 'conflict':
      case 'unloaded':
        return unanswered({
          kind: claim.kind,
          title,
          files: claim.files.map(shown),
        });
      case 'unclaimed':
        return toMain
          ? answered(snapshot.mainAgent)
          : unanswered({
              kind: 'unclaimed',
              title,
              note: shown(posix.join(NOTE_FOLDERS.agent, `${title}.md`)),
            });
    }
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
   * read at all, as when the settings folder is unreadable, there are no
   * Agents and every default is Pero's own.
   */
  private current(): {
    snapshot: SettingsSnapshot;
    dataFolder: string;
    settingsFolder: string;
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
      settingsFolder: folders.settingsFolder,
      workspace: folders.workspace,
    };
  }
}

/** The Agent named `name`; `NotFoundError` if none. */
export function requireAgent(definitions: Definitions, name: string): Agent {
  const agent = definitions.agent(name);
  if (agent === null) throw new NotFoundError(`No Agent named ${name}`);
  return agent;
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
