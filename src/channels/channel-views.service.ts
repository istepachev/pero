import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { NotFoundError } from '../common/errors.js';
import type {
  ChannelDetails,
  ChannelView,
  HistoryMessage,
} from '../control/protocol.js';
import { DefinitionIds } from '../definitions/definition-ids.js';
import {
  type AgentDefinition,
  Definitions,
} from '../definitions/definitions.js';
import {
  MessageHistory,
  workflowOf,
} from '../history/message-history.service.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Session } from '../persistence/entities/session.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { nextTurn } from '../sessions/next-turn.js';
import { assignedAgent } from './channel-stages.js';

/**
 * Channels as the CLI shows them: their Agent, what the next turn there
 * does with its Session, and their message history.
 */
@Injectable()
export class ChannelViews {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly messages: MessageHistory,
    private readonly definitions: Definitions,
    private readonly ids: DefinitionIds,
  ) {}

  /** Every Channel, by ID. */
  async list(): Promise<ChannelView[]> {
    const channels = await this.dataSource
      .getRepository(Channel)
      .find({ order: { id: 'ASC' } });
    const names = await this.ids.agentNames();
    const agents = new Map(
      (await this.definitions.agents()).map((agent) => [agent.name, agent]),
    );
    return channels.map((channel) => {
      // The foreign key guarantees the name; a note may not define it.
      const name = names.get(channel.agentId)!;
      return channelView(channel, name, agents.get(name) ?? null);
    });
  }

  /** The Channel with ID `id`; `NotFoundError` if none. */
  async details(id: number): Promise<ChannelDetails> {
    const { historyCarryover } = await this.definitions.defaults();
    return inTransaction(this.dataSource, async (manager) => {
      const channel = await findChannel(manager, id);
      const { name, agent } = await this.agentOf(channel);
      const active = await manager.getRepository(Session).findOneBy({
        channelId: id,
        agentName: name,
        status: 'active',
      });
      const withHistory = await this.messages.channelsWithHistoryWithin(
        manager,
        [id],
      );
      const { count, lastAt } = await this.messages.statsWithin(manager, id);
      return {
        ...channelView(channel, name, agent),
        nextTurn:
          agent === null
            ? null
            : nextTurn(active, agent, {
                hasHistory: withHistory.has(id),
                carryover: historyCarryover,
              }),
        messages: count,
        lastMessageAt: lastAt?.toISOString() ?? null,
      };
    });
  }

  /** The Channel and its latest `limit` messages, oldest first. */
  history(
    id: number,
    limit: number,
  ): Promise<{ channel: ChannelView; messages: HistoryMessage[] }> {
    return inTransaction(this.dataSource, async (manager) => {
      const channel = await findChannel(manager, id);
      const { name, agent } = await this.agentOf(channel);
      const messages = await this.messages.latestWithin(manager, id, limit);
      return {
        channel: channelView(channel, name, agent),
        messages: messages.map((message) => ({
          id: message.id,
          createdAt: message.createdAt.toISOString(),
          direction: message.direction,
          origin: message.origin,
          agent: message.agentName,
          workflow: workflowOf(message),
          senderId: message.senderId,
          text: message.text,
        })),
      };
    });
  }

  private agentOf(channel: Channel) {
    return assignedAgent(channel, this.definitions, this.ids);
  }
}

/** The Channel with ID `id`; `NotFoundError` if none. */
export async function findChannel(
  manager: EntityManager,
  id: number,
): Promise<Channel> {
  const channel = await manager.getRepository(Channel).findOneBy({ id });
  if (channel === null) throw new NotFoundError(`No Channel with ID ${id}`);
  return channel;
}

function channelView(
  channel: Pick<
    Channel,
    'id' | 'integrationKind' | 'externalKey' | 'title' | 'enabled' | 'createdAt'
  >,
  name: string,
  agent: Pick<AgentDefinition, 'enabled'> | null,
): ChannelView {
  return {
    id: channel.id,
    integrationKind: channel.integrationKind,
    key: channel.externalKey,
    title: channel.title,
    agent: name,
    agentEnabled: agent?.enabled ?? false,
    agentDefined: agent !== null,
    enabled: channel.enabled,
    createdAt: channel.createdAt.toISOString(),
  };
}
