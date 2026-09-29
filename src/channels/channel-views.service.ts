import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { effectiveWorkingDirectory } from '../agents/agent-resolution.js';
import { NotFoundError } from '../common/errors.js';
import type {
  ChannelDetails,
  ChannelView,
  HistoryMessage,
} from '../control/protocol.js';
import {
  MessageHistory,
  workflowOf,
} from '../history/message-history.service.js';
import type { Agent } from '../persistence/entities/agent.entity.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Session } from '../persistence/entities/session.entity.js';
import {
  SETTINGS_ID,
  Settings,
} from '../persistence/entities/settings.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { nextTurn } from '../sessions/next-turn.js';

type ChannelWithAgent = Channel & { agent: Agent };

/**
 * Channels as the CLI shows them: their Agent, what the next turn there
 * does with its Session, and their message history.
 */
@Injectable()
export class ChannelViews {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly messages: MessageHistory,
  ) {}

  /** Every Channel, by ID. */
  async list(): Promise<ChannelView[]> {
    const channels = await this.dataSource.getRepository(Channel).find({
      relations: { agent: true },
      order: { id: 'ASC' },
    });
    return (channels as ChannelWithAgent[]).map(channelView);
  }

  /** The Channel with ID `id`; `NotFoundError` if none. */
  details(id: number): Promise<ChannelDetails> {
    return inTransaction(this.dataSource, async (manager) => {
      const channel = await findChannel(manager, id);
      const settings = await manager
        .getRepository(Settings)
        .findOneByOrFail({ id: SETTINGS_ID });
      const active = await manager.getRepository(Session).findOneBy({
        channelId: id,
        agentId: channel.agentId,
        status: 'active',
      });
      const withHistory = await this.messages.channelsWithHistoryWithin(
        manager,
        [id],
      );
      const { count, lastAt } = await this.messages.statsWithin(manager, id);
      return {
        ...channelView(channel),
        nextTurn: nextTurn(
          active,
          {
            provider: channel.agent.provider,
            workingDirectory: effectiveWorkingDirectory(
              channel.agent,
              settings,
            ),
          },
          {
            hasHistory: withHistory.has(id),
            carryover: settings.historyCarryover,
          },
        ),
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
      const messages = await this.messages.latestWithin(manager, id, limit);
      return {
        channel: channelView(channel),
        messages: messages.map((message) => ({
          id: message.id,
          createdAt: message.createdAt.toISOString(),
          direction: message.direction,
          origin: message.origin,
          agent: message.agent?.name ?? null,
          workflow: workflowOf(message),
          senderId: message.senderId,
          text: message.text,
        })),
      };
    });
  }
}

/** The Channel with ID `id` and its Agent; `NotFoundError` if none. */
export async function findChannel(
  manager: EntityManager,
  id: number,
): Promise<ChannelWithAgent> {
  const channel = await manager.getRepository(Channel).findOne({
    where: { id },
    relations: { agent: true },
  });
  if (channel === null) throw new NotFoundError(`No Channel with ID ${id}`);
  // The foreign key guarantees the Agent.
  return channel as ChannelWithAgent;
}

function channelView(channel: ChannelWithAgent): ChannelView {
  return {
    id: channel.id,
    integrationKind: channel.integrationKind,
    key: channel.externalKey,
    title: channel.title,
    agent: channel.agent.name,
    agentEnabled: channel.agent.enabled,
    enabled: channel.enabled,
    createdAt: channel.createdAt.toISOString(),
  };
}
