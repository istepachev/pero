import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import type { HistoryMessages } from '../config/workflow-input.js';
import {
  Message,
  type MessageOrigin,
} from '../persistence/entities/message.entity.js';
import {
  SETTINGS_ID,
  Settings,
} from '../persistence/entities/settings.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { withEarlierConversation } from './carry-over.js';

/** Who wrote a message Pero sent: an Agent in its Session, or Pero itself. */
export type Author =
  { origin: 'agent'; agentId: number; sessionId: number } | { origin: 'pero' };

/** A person's message to a Channel's Agent. */
export interface InboundEntry {
  channelId: number;
  agentId: number;
  externalMessageId: string;
  senderId: string;
  text: string;
}

/** A message Pero has sent to a Channel. */
export interface OutboundEntry {
  channelId: number;
  externalMessageId: string;
  text: string;
  author: Author;
}

/** The conversation a fresh Session starts from; Pero's notices are left out. */
const CARRIED_ORIGINS: readonly MessageOrigin[] = ['user', 'agent'];

/** The origins each choice of a Workflow's history input reads. */
const WINDOW_ORIGINS: Record<HistoryMessages, readonly MessageOrigin[]> = {
  people: ['user'],
  all: CARRIED_ORIGINS,
};

/**
 * A window of history a Workflow Run reads: messages after `afterId`, or
 * from `since` when there is no earlier window, up to `untilId`.
 */
export interface HistoryWindow {
  channels: 'all' | readonly number[];
  messages: HistoryMessages;
  /** Exclusive; null starts at `since`. */
  afterId: number | null;
  /** ISO time; used only while `afterId` is null. */
  since: string | null;
  /** Inclusive. */
  untilId: number;
}

/**
 * Each Channel's message history: the text sent and received there, and
 * nothing else. A fresh Session starts from its latest messages.
 */
@Injectable()
export class MessageHistory {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Records a person's message inside the caller's transaction; resolves
   * to its ID. Its Session is attached once its turn starts.
   */
  async recordInboundWithin(
    manager: EntityManager,
    entry: InboundEntry,
  ): Promise<number> {
    const { identifiers } = await manager.getRepository(Message).insert({
      ...entry,
      direction: 'in',
      origin: 'user',
      sessionId: null,
    });
    return (identifiers[0] as { id: number }).id;
  }

  /** Records a message once it has been sent: one row however it was split. */
  async recordOutbound({ author, ...entry }: OutboundEntry): Promise<void> {
    await inTransaction(this.dataSource, (manager) =>
      manager.getRepository(Message).insert({
        ...entry,
        direction: 'out',
        origin: author.origin,
        agentId: author.origin === 'agent' ? author.agentId : null,
        sessionId: author.origin === 'agent' ? author.sessionId : null,
        senderId: null,
      }),
    );
  }

  /** Links message `messageId` to the Session its turn runs in. */
  async attachSessionWithin(
    manager: EntityManager,
    messageId: number,
    sessionId: number,
  ): Promise<void> {
    await manager.getRepository(Message).update(messageId, { sessionId });
  }

  /**
   * Which of `channelIds` have messages a fresh Session there would start
   * with, inside the caller's transaction.
   */
  async channelsWithHistoryWithin(
    manager: EntityManager,
    channelIds: readonly number[],
  ): Promise<Set<number>> {
    if (channelIds.length === 0) return new Set();
    const rows = await manager
      .getRepository(Message)
      .createQueryBuilder('message')
      .select('DISTINCT message.channelId', 'channelId')
      .where('message.channelId IN (:...channelIds)', { channelIds })
      .andWhere('message.origin IN (:...origins)', {
        origins: CARRIED_ORIGINS,
      })
      .getRawMany<{ channelId: number }>();
    return new Set(rows.map((row) => Number(row.channelId)));
  }

  /**
   * The Channel's latest `limit` messages, oldest first, with the Agent
   * each was to or from, inside the caller's transaction.
   */
  async latestWithin(
    manager: EntityManager,
    channelId: number,
    limit: number,
  ): Promise<Message[]> {
    const latest = await manager.getRepository(Message).find({
      where: { channelId },
      relations: { agent: true },
      order: { id: 'DESC' },
      take: limit,
    });
    return latest.reverse();
  }

  /**
   * The ID of the latest message of any Channel, 0 when there is none,
   * inside the caller's transaction. Writes are serialized, so no message
   * recorded later can have a lower ID.
   */
  async latestIdWithin(manager: EntityManager): Promise<number> {
    const row = await manager
      .getRepository(Message)
      .createQueryBuilder('message')
      .select('MAX(message.id)', 'id')
      .getRawOne<{ id: number | null }>();
    return Number(row?.id ?? 0);
  }

  /**
   * The messages of `window`, oldest first, with their Channel and the
   * Agent each was to or from, inside the caller's transaction. Pero's own
   * notices are left out.
   */
  async windowWithin(
    manager: EntityManager,
    window: HistoryWindow,
  ): Promise<Message[]> {
    const query = manager
      .getRepository(Message)
      .createQueryBuilder('message')
      .innerJoinAndSelect('message.channel', 'channel')
      .leftJoinAndSelect('message.agent', 'agent')
      .where('message.id <= :untilId', { untilId: window.untilId })
      .andWhere('message.origin IN (:...origins)', {
        origins: WINDOW_ORIGINS[window.messages],
      });
    if (window.afterId !== null) {
      query.andWhere('message.id > :afterId', { afterId: window.afterId });
    } else if (window.since !== null) {
      query.andWhere('message.createdAt >= :since', {
        since: new Date(window.since),
      });
    }
    if (window.channels !== 'all') {
      query.andWhere('message.channelId IN (:...channelIds)', {
        channelIds: window.channels,
      });
    }
    return query.orderBy('message.id', 'ASC').getMany();
  }

  /**
   * How many messages the Channel's history holds, and when the latest
   * was sent, inside the caller's transaction.
   */
  async statsWithin(
    manager: EntityManager,
    channelId: number,
  ): Promise<{ count: number; lastAt: Date | null }> {
    const messages = manager.getRepository(Message);
    const count = await messages.countBy({ channelId });
    const last = await messages.findOne({
      where: { channelId },
      order: { id: 'DESC' },
    });
    return { count, lastAt: last?.createdAt ?? null };
  }

  /**
   * `input` preceded by the Channel's latest messages from before message
   * `beforeId`, up to the `history-carryover` setting, for a Session whose
   * provider has none of the conversation yet. Also says how many it
   * carried; none when the setting is 0 or there is no earlier message.
   */
  async carryOverWithin(
    manager: EntityManager,
    channelId: number,
    beforeId: number,
    input: string,
  ): Promise<{ input: string; carried: number }> {
    const { historyCarryover, timezone } = await manager
      .getRepository(Settings)
      .findOneByOrFail({ id: SETTINGS_ID });
    if (historyCarryover === 0) return { input, carried: 0 };
    const latest = await manager
      .getRepository(Message)
      .createQueryBuilder('message')
      .leftJoinAndSelect('message.agent', 'agent')
      .where('message.channelId = :channelId', { channelId })
      .andWhere('message.id < :beforeId', { beforeId })
      .andWhere('message.origin IN (:...origins)', {
        origins: CARRIED_ORIGINS,
      })
      .orderBy('message.createdAt', 'DESC')
      .addOrderBy('message.id', 'DESC')
      .limit(historyCarryover)
      .getMany();
    const carried = withEarlierConversation(
      input,
      latest.reverse().map((message) => ({
        speaker:
          message.origin === 'user' ? 'User' : (message.agent?.name ?? 'Agent'),
        text: message.text,
        createdAt: message.createdAt,
      })),
      timezone,
    );
    return { input: carried, carried: latest.length };
  }
}
