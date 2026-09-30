import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { InvalidInputError, NotFoundError } from '../common/errors.js';
import { validateWorkingDirectory } from '../config/working-directory.js';
import type {
  AgentChannelView,
  AgentDetails,
  AgentView,
} from '../control/protocol.js';
import { DefinitionIds } from '../definitions/definition-ids.js';
import {
  type AgentDefinition,
  type Defaults,
  Definitions,
} from '../definitions/definitions.js';
import { MessageHistory } from '../history/message-history.service.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Session } from '../persistence/entities/session.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { nextTurn } from '../sessions/next-turn.js';
import { SettingsNotes } from '../settings-notes/settings-notes.service.js';
import { findAgentNote, shownPath } from '../settings-files/note-hints.js';
import { agentOrigins } from '../settings-files/origins.js';

/**
 * Agents as the CLI shows them: their settings with defaults resolved, and
 * what the next turn in each of their Channels will do with its Session.
 */
@Injectable()
export class AgentViews {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly history: MessageHistory,
    private readonly definitions: Definitions,
    private readonly ids: DefinitionIds,
    private readonly notes: SettingsNotes,
  ) {}

  /** Every Agent, by name. */
  async list(): Promise<AgentView[]> {
    const main = (await this.definitions.mainAgent())?.name ?? null;
    return (await this.definitions.agents()).map((agent) =>
      this.view(agent, main),
    );
  }

  /** The Agent named `name` with its Channels; `NotFoundError` if none. */
  async details(name: string): Promise<AgentDetails> {
    const agent = await this.definitions.agent(name);
    if (agent === null) throw this.notFound(name);
    const main = (await this.definitions.mainAgent())?.name ?? null;
    const defaults = await this.definitions.defaults();
    const id = await this.ids.findAgentId(agent.name);
    const view = {
      ...this.view(agent, main),
      channels: id === null ? [] : await this.channels(id, agent, defaults),
    };
    return { ...view, folderProblem: await folderProblem(view) };
  }

  /** `agent` as the CLI shows it, with its note when notes define it. */
  private view(agent: AgentDefinition, main: string | null): AgentView {
    const snapshot = this.notes.snapshot();
    const folders = this.notes.folders();
    const note = snapshot?.agents.get(agent.name);
    if (snapshot === null || folders === null || note === undefined) {
      return {
        ...agentView(agent, main),
        file: null,
        topics: [],
        origins: null,
        errors: [],
      };
    }
    return {
      ...agentView(agent, main),
      file: shownPath(
        folders.workspace,
        join(folders.settingsFolder, note.file),
      ),
      topics: [...note.topics],
      origins: agentOrigins(note, snapshot.peroProperties),
      errors: snapshot.errors
        .filter((error) => error.file === note.file)
        .map(({ property, message }) => ({ property, message })),
    };
  }

  /**
   * Why there is no Agent named `name`: its note has errors and never
   * loaded, or there is no such note.
   */
  private notFound(name: string): NotFoundError {
    const snapshot = this.notes.snapshot();
    const folders = this.notes.folders();
    if (snapshot !== null && folders !== null) {
      const broken = findAgentNote(
        snapshot.errors.map((error) => error.file),
        name,
      );
      if (broken !== null) {
        const file = shownPath(
          folders.workspace,
          join(folders.settingsFolder, broken),
        );
        return new NotFoundError(
          `Agent ${name} isn't loaded: ${file} has errors; pero check lists them`,
        );
      }
    }
    return new NotFoundError(`No Agent named ${name}`);
  }

  /** The Channels Agent `id` answers in, with what its next turn does. */
  private channels(
    id: number,
    agent: AgentDefinition,
    defaults: Defaults,
  ): Promise<AgentChannelView[]> {
    return inTransaction(this.dataSource, async (manager) => {
      const channels = await manager
        .getRepository(Channel)
        .find({ where: { agentId: id }, order: { id: 'ASC' } });
      const sessions = await manager
        .getRepository(Session)
        .findBy({ agentName: agent.name, status: 'active' });
      const withHistory = await this.history.channelsWithHistoryWithin(
        manager,
        channels.map((channel) => channel.id),
      );
      return channels.map((channel): AgentChannelView => ({
        id: channel.id,
        integrationKind: channel.integrationKind,
        key: channel.externalKey,
        title: channel.title,
        enabled: channel.enabled,
        nextTurn: nextTurn(
          sessions.find((session) => session.channelId === channel.id) ?? null,
          agent,
          {
            hasHistory: withHistory.has(channel.id),
            carryover: defaults.historyCarryover,
          },
        ),
      }));
    });
  }
}

function agentView(
  agent: AgentDefinition,
  main: string | null,
): Omit<AgentView, 'file' | 'topics' | 'origins' | 'errors'> {
  return {
    name: agent.name,
    title: agent.title,
    provider: agent.provider,
    model: agent.providerOptions.model,
    effort: agent.providerOptions.effort,
    workingDirectory: agent.ownWorkingDirectory,
    effectiveWorkingDirectory: agent.workingDirectory,
    instructions: agent.instructions,
    useSharedInstructions: agent.sharedInstructions,
    permissions: agent.permissions,
    codexSkipGitRepoCheck: agent.skipGitRepoCheck,
    enabled: agent.enabled,
    main: agent.name === main,
  };
}

/** Why the Agent's folder cannot be used now, such as a missing vault. */
async function folderProblem(
  view: Pick<AgentView, 'effectiveWorkingDirectory'>,
): Promise<string | null> {
  try {
    await validateWorkingDirectory(view.effectiveWorkingDirectory);
    return null;
  } catch (error) {
    if (error instanceof InvalidInputError) return error.message;
    throw error;
  }
}
