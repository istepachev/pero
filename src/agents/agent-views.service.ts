import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { InvalidInputError } from '../common/errors.js';
import { validateWorkingDirectory } from '../config/working-directory.js';
import type {
  AgentChannelView,
  AgentDetails,
  AgentView,
} from '../control/protocol.js';
import { MessageHistory } from '../history/message-history.service.js';
import { Agent } from '../persistence/entities/agent.entity.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Session } from '../persistence/entities/session.entity.js';
import {
  SETTINGS_ID,
  Settings,
} from '../persistence/entities/settings.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { nextTurn } from '../sessions/next-turn.js';
import { effectiveWorkingDirectory } from './agent-resolution.js';
import { findAgent } from './agents.service.js';

/**
 * Agents as the CLI shows them: their settings with defaults resolved, and
 * what the next turn in each of their Channels will do with its Session.
 */
@Injectable()
export class AgentViews {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly history: MessageHistory,
  ) {}

  /** Every Agent, by name. */
  list(): Promise<AgentView[]> {
    return inTransaction(this.dataSource, async (manager) => {
      const settings = await getSettings(manager);
      const agents = await manager
        .getRepository(Agent)
        .find({ order: { name: 'ASC' } });
      return agents.map((agent) => agentView(agent, settings));
    });
  }

  /** The Agent named `name` with its Channels; `NotFoundError` if none. */
  async details(name: string): Promise<AgentDetails> {
    const view = await inTransaction(this.dataSource, async (manager) =>
      this.detailsWithin(manager, await findAgent(manager, name)),
    );
    return { ...view, folderProblem: await folderProblem(view) };
  }

  private async detailsWithin(
    manager: EntityManager,
    agent: Agent,
  ): Promise<Omit<AgentDetails, 'folderProblem'>> {
    const settings = await getSettings(manager);
    const view = agentView(agent, settings);
    const channels = await manager
      .getRepository(Channel)
      .find({ where: { agentId: agent.id }, order: { id: 'ASC' } });
    const sessions = await manager
      .getRepository(Session)
      .findBy({ agentId: agent.id, status: 'active' });
    const withHistory = await this.history.channelsWithHistoryWithin(
      manager,
      channels.map((channel) => channel.id),
    );
    const resolved = {
      provider: agent.provider,
      workingDirectory: view.effectiveWorkingDirectory,
    };
    return {
      ...view,
      channels: channels.map((channel): AgentChannelView => ({
        id: channel.id,
        integrationKind: channel.integrationKind,
        key: channel.externalKey,
        title: channel.title,
        enabled: channel.enabled,
        nextTurn: nextTurn(
          sessions.find((session) => session.channelId === channel.id) ?? null,
          resolved,
          {
            hasHistory: withHistory.has(channel.id),
            carryover: settings.historyCarryover,
          },
        ),
      })),
    };
  }
}

function agentView(agent: Agent, settings: Settings): AgentView {
  return {
    name: agent.name,
    title: agent.title,
    provider: agent.provider,
    model: agent.providerOptions.model,
    effort: agent.providerOptions.effort,
    workingDirectory: agent.workingDirectory,
    effectiveWorkingDirectory: effectiveWorkingDirectory(agent, settings),
    instructions: agent.instructions,
    useSharedInstructions: agent.useSharedInstructions,
    permissions: agent.toolPolicy.permissions,
    codexSkipGitRepoCheck: agent.codexSkipGitRepoCheck,
    enabled: agent.enabled,
    main: settings.mainAgentId === agent.id,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
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

function getSettings(manager: EntityManager): Promise<Settings> {
  return manager.getRepository(Settings).findOneByOrFail({ id: SETTINGS_ID });
}
