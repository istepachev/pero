import { Injectable } from '@nestjs/common';
import { homedir } from 'node:os';
import type { ProviderOptions } from '../config/provider-options.js';
import { SettingsNotes } from '../settings-notes/settings-notes.service.js';
import {
  type AgentDefinition as NoteAgent,
  buildSnapshot,
  type SettingsSnapshot,
} from '../settings-files/snapshot.js';
import {
  type AgentDefinition,
  type Defaults,
  Definitions,
  type WorkflowDefinition,
} from './definitions.js';
import { SqliteDefinitions } from './sqlite-definitions.js';

/**
 * The definitions of a workspace: the defaults and the Agents from its
 * notes, as the current snapshot holds them, so an edit applies from the
 * next turn. Workflows still come from SQLite until plan step 9.1.
 */
@Injectable()
export class FileDefinitions extends Definitions {
  constructor(
    private readonly notes: SettingsNotes,
    private readonly sqlite: SqliteDefinitions,
  ) {
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

  workflow(name: string): Promise<WorkflowDefinition | null> {
    return this.sqlite.workflow(name);
  }

  workflows(): Promise<WorkflowDefinition[]> {
    return this.sqlite.workflows();
  }

  onChange(listener: () => void): () => void {
    const stopNotes = this.notes.onChange(() => listener());
    const stopSqlite = this.sqlite.onChange(listener);
    return () => {
      stopNotes();
      stopSqlite();
    };
  }

  /**
   * The snapshot in use, and the data folder. Before the notes could be
   * read at all, as when the settings folder is unreadable, there are no
   * Agents and every default is Pero's own.
   */
  private async current(): Promise<{
    snapshot: SettingsSnapshot;
    dataFolder: string;
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
