import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { InvalidInputError } from '../common/errors.js';
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
  requireAgent,
} from '../definitions/definitions.js';
import { MessageHistory } from '../history/message-history.service.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Session } from '../persistence/entities/session.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { nextTurn } from '../sessions/next-turn.js';

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
  ) {}

  /** Every Agent, by name. */
  async list(): Promise<AgentView[]> {
    const main = (await this.definitions.mainAgent())?.name ?? null;
    return (await this.definitions.agents()).map((agent) =>
      agentView(agent, main),
    );
  }

  /** The Agent named `name` with its Channels; `NotFoundError` if none. */
  async details(name: string): Promise<AgentDetails> {
    const agent = await requireAgent(this.definitions, name);
    const main = (await this.definitions.mainAgent())?.name ?? null;
    const defaults = await this.definitions.defaults();
    const id = await this.ids.agentId(agent.name);
    const view = {
      ...agentView(agent, main),
      channels: await this.channels(id, agent, defaults),
    };
    return { ...view, folderProblem: await folderProblem(view) };
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

function agentView(agent: AgentDefinition, main: string | null): AgentView {
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
async function folderProblem(view: AgentView): Promise<string | null> {
  try {
    await validateWorkingDirectory(view.effectiveWorkingDirectory);
    return null;
  } catch (error) {
    if (error instanceof InvalidInputError) return error.message;
    throw error;
  }
}
