import { Injectable } from '@nestjs/common';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import type { ProviderOptions } from '../config/provider-options.js';
import { SettingsNotes } from '../settings-notes/settings-notes.service.js';
import { shownPath } from '../settings-files/note-hints.js';
import { agentNoteFor } from '../settings-files/note-writer.js';
import { NOTE_FOLDERS } from '../settings-files/note-files.js';
import {
  type AgentDefinition as NoteAgent,
  buildSnapshot,
  type SettingsSnapshot,
  topicClaim,
  type WorkflowDefinition as NoteWorkflow,
} from '../settings-files/snapshot.js';
import {
  type AgentDefinition,
  type Defaults,
  Definitions,
  type Route,
  type RouteQuery,
  type Unanswered,
  type WorkflowDefinition,
} from './definitions.js';

/**
 * The definitions of a workspace: the defaults, the Agents, and the
 * Workflows from its notes, as the current snapshot holds them, so an
 * edit applies from the next turn or run.
 */
@Injectable()
export class FileDefinitions extends Definitions {
  constructor(private readonly notes: SettingsNotes) {
    super();
  }

  async defaults(): Promise<Defaults> {
    const { snapshot, dataFolder } = await this.current();
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

  async agent(name: string): Promise<AgentDefinition | null> {
    const { snapshot } = await this.current();
    const agent = snapshot.agents.get(name.toLowerCase());
    return agent === undefined ? null : agentDefinition(agent);
  }

  async agents(): Promise<AgentDefinition[]> {
    const { snapshot } = await this.current();
    return [...snapshot.agents.values()]
      .map(agentDefinition)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async mainAgent(): Promise<AgentDefinition | null> {
    const { snapshot } = await this.current();
    const agent = snapshot.agents.get(snapshot.mainAgent);
    return agent === undefined ? null : agentDefinition(agent);
  }

  async mainAgentName(): Promise<string> {
    return (await this.current()).snapshot.mainAgent;
  }

  async route(channel: RouteQuery): Promise<Route> {
    const { snapshot, settingsFolder, workspace } = await this.current();
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

  async workflow(name: string): Promise<WorkflowDefinition | null> {
    const { snapshot } = await this.current();
    const workflow = snapshot.workflows.get(name.toLowerCase());
    return workflow === undefined ? null : workflowDefinition(workflow);
  }

  async workflows(): Promise<WorkflowDefinition[]> {
    const { snapshot } = await this.current();
    return [...snapshot.workflows.values()]
      .map(workflowDefinition)
      .filter((workflow) => workflow !== null)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  onChange(listener: () => void): () => void {
    return this.notes.onChange(() => listener());
  }

  /**
   * The snapshot in use, and the data folder. Before the notes could be
   * read at all, as when the settings folder is unreadable, there are no
   * Agents and every default is Pero's own.
   */
  private async current(): Promise<{
    snapshot: SettingsSnapshot;
    dataFolder: string;
    settingsFolder: string;
    workspace: string;
  }> {
    const snapshot = await this.notes.ready();
    const folders = this.notes.folders();
    if (folders === null) {
      throw new Error('Agents come from notes only in a workspace');
    }
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
    schedules: workflow.schedule === null ? [] : [workflow.schedule],
    enabled: workflow.enabled,
  };
}
