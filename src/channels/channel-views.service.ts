import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { NotFoundError } from '../common/errors.js';
import type {
  ChannelDetails,
  ChannelView,
  HistoryMessage,
} from '../control/protocol.js';
import { Definitions, type Route } from '../definitions/definitions.js';
import {
  MessageHistory,
  workflowOf,
} from '../history/message-history.service.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Session } from '../persistence/entities/session.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { nextTurn } from '../sessions/next-turn.js';
import { routeOf, unansweredSummary } from './channel-stages.js';

/**
 * Channels as the CLI shows them: the Agent that answers there now, what
 * the next turn there does with its Session, and their message history.
 */
@Injectable()
export class ChannelViews {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly messages: MessageHistory,
    private readonly definitions: Definitions,
  ) {}

  /** Every Channel, by ID. */
  async list(): Promise<ChannelView[]> {
    const channels = await this.dataSource
      .getRepository(Channel)
      .find({ order: { id: 'ASC' } });
    return Promise.all(
      channels.map(async (channel) =>
        channelView(channel, await routeOf(channel, this.definitions)),
      ),
    );
  }

  /** The Channel with ID `id`; `NotFoundError` if none. */
  async details(id: number): Promise<ChannelDetails> {
    const { historyCarryover } = await this.definitions.defaults();
    return inTransaction(this.dataSource, async (manager) => {
      const channel = await findChannel(manager, id);
      const route = await routeOf(channel, this.definitions);
      const agent = route.kind === 'agent' ? route.agent : null;
      const active =
        agent === null
          ? null
          : await manager.getRepository(Session).findOneBy({
              channelId: id,
              agentName: agent.name,
              status: 'active',
            });
      const withHistory = await this.messages.channelsWithHistoryWithin(
        manager,
        [id],
      );
      const { count, lastAt } = await this.messages.statsWithin(manager, id);
      return {
        ...channelView(channel, route),
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
      const route = await routeOf(channel, this.definitions);
      const messages = await this.messages.latestWithin(manager, id, limit);
      return {
        channel: channelView(channel, route),
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
    'id' | 'integrationKind' | 'externalKey' | 'title' | 'createdAt'
  >,
  route: Route,
): ChannelView {
  const { agent, agentEnabled } =
    route.kind === 'agent'
      ? { agent: route.agent.name, agentEnabled: true }
      : route.reason.kind === 'disabled'
        ? { agent: route.reason.agent, agentEnabled: false }
        : { agent: null, agentEnabled: false };
  return {
    id: channel.id,
    integrationKind: channel.integrationKind,
    key: channel.externalKey,
    title: channel.title,
    agent,
    agentEnabled,
    unanswered: route.kind === 'agent' ? null : unansweredSummary(route.reason),
    createdAt: channel.createdAt.toISOString(),
  };
}
