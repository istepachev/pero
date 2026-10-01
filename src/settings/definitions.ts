import { Injectable } from '@nestjs/common';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import { NotFoundError } from '../common/errors.js';
import type {
  Provider,
  ProviderDefaults,
  ProviderOptions,
} from '../config/provider-options.js';
import type { PermissionMode } from '../config/tool-policy.js';
import type { WorkflowHistory } from '../config/workflow-input.js';
import type { Schedule } from '../scheduler/schedule.js';
import { shownPath } from '../settings-files/note-paths.js';
import { agentNoteFor } from '../settings-files/note-writer.js';
import { NOTE_FOLDERS } from '../settings-files/note-files.js';
import {
  type AgentDefinition as NoteAgent,
  buildSnapshot,
  type SettingsSnapshot,
  topicClaim,
  type WorkflowDefinition as NoteWorkflow,
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
  /** Where Agents without a folder of their own work. */
  dataFolder: string;
  /** Placed before each opted-in Agent's own instructions; null for none. */
  sharedInstructions: string | null;
}

/** An Agent as it runs, with the defaults it follows applied. */
export interface AgentDefinition {
  name: string;
  /** Display name; null shows `name`. */
  title: string | null;
  provider: Provider;
  /** Model and effort for `provider`; null lets the provider choose. */
  providerOptions: ProviderOptions;
  permissions: PermissionMode;
  /** The folder it works in, absolute: its own, or the data folder. */
  workingDirectory: string;
  /** Its own folder; null follows the data folder. */
  ownWorkingDirectory: string | null;
  /** Its own instructions; null for none. */
  instructions: string | null;
  /** Whether the shared instructions precede its own. */
  sharedInstructions: boolean;
  /** Lets a Codex Agent work in a folder that is not a Git repository. */
  skipGitRepoCheck: boolean;
  enabled: boolean;
}

/** A Workflow as it runs. */
export interface WorkflowDefinition {
  name: string;
  /** Display name; null shows `name`. */
  title: string | null;
  /** The name of the Agent that runs it. */
  agent: string;
  /** What each run sends the Agent. */
  input: string;
  /** The Channel history each run reads; null reads none. */
  history: WorkflowHistory | null;
  /** The Channels, by ID, told of each run that finishes. */
  targets: number[];
  /** How many times a run of it may start in all. */
  maxAttempts: number;
  /** When it runs by itself: a cron expression in a time zone; null for never. */
  schedule: Schedule | null;
  enabled: boolean;
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
  | { kind: 'agent'; agent: AgentDefinition }
  | { kind: 'unanswered'; reason: Unanswered };

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
  agent(name: string): AgentDefinition | null {
    const { snapshot } = this.current();
    const agent = snapshot.agents.get(name.toLowerCase());
    return agent === undefined ? null : agentDefinition(agent);
  }

  /** Every Agent, by name. */
  agents(): AgentDefinition[] {
    const { snapshot } = this.current();
    return [...snapshot.agents.values()]
      .map(agentDefinition)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The Agent primary Channels get; null while no note defines it. */
  mainAgent(): AgentDefinition | null {
    const { snapshot } = this.current();
    const agent = snapshot.agents.get(snapshot.mainAgent);
    return agent === undefined ? null : agentDefinition(agent);
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
      return { kind: 'agent', agent: agentDefinition(agent) };
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

  /** The Workflow named `name`, in any case; null if none. */
  workflow(name: string): WorkflowDefinition | null {
    const { snapshot } = this.current();
    const workflow = snapshot.workflows.get(name.toLowerCase());
    return workflow === undefined ? null : workflowDefinition(workflow);
  }

  /** Every Workflow, by name. */
  workflows(): WorkflowDefinition[] {
    const { snapshot } = this.current();
    return [...snapshot.workflows.values()]
      .map(workflowDefinition)
      .filter((workflow) => workflow !== null)
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
          dataFolder: folders.dataFolder,
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
export function requireAgent(
  definitions: Definitions,
  name: string,
): AgentDefinition {
  const agent = definitions.agent(name);
  if (agent === null) throw new NotFoundError(`No Agent named ${name}`);
  return agent;
}

/** The Workflow named `name`; `NotFoundError` if none. */
export function requireWorkflow(
  definitions: Definitions,
  name: string,
): WorkflowDefinition {
  const workflow = definitions.workflow(name);
  if (workflow === null) throw new NotFoundError(`No Workflow named ${name}`);
  return workflow;
}

/** The Agent in a note, as runtime code reads it. */
export function agentDefinition(agent: NoteAgent): AgentDefinition {
  return {
    name: agent.name,
    title: agent.title,
    provider: agent.provider,
    // The snapshot checked the effort against the provider.
    providerOptions: {
      model: agent.model,
      effort: agent.effort as ProviderOptions['effort'],
    },
    permissions: agent.permissions,
    workingDirectory: agent.workingDirectory,
    ownWorkingDirectory:
      agent.note.workingDirectory === null ? null : agent.workingDirectory,
    instructions: agent.instructions,
    sharedInstructions: agent.sharedInstructions,
    skipGitRepoCheck: agent.skipGitRepoCheck,
    enabled: agent.enabled,
  };
}

/**
 * The Workflow in a note, as runtime code reads it; null until its Channel
 * references resolve, which they do wherever Pero runs with a database.
 */
export function workflowDefinition(
  workflow: NoteWorkflow,
): WorkflowDefinition | null {
  const { resolved, agent } = workflow;
  if (resolved === null || agent === null) return null;
  return {
    name: workflow.name,
    title: workflow.title,
    agent,
    input: workflow.input,
    history:
      workflow.history === null
        ? null
        : {
            channels:
              resolved.history === 'all'
                ? 'all'
                : [...resolved.history].sort((a, b) => a - b),
            messages: workflow.history.messages,
            hours: workflow.history.hours,
            runWhenEmpty: workflow.history.runWhenEmpty,
          },
    targets: [...resolved.targets],
    maxAttempts: workflow.maxAttempts,
    schedule: workflow.schedule,
    enabled: workflow.enabled,
  };
}
