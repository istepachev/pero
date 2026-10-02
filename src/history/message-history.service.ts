import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager, SelectQueryBuilder } from 'typeorm';
import type { HistoryMessages } from '../config/workflow-input.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import {
  Message,
  type MessageOrigin,
} from '../persistence/entities/message.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { Definitions } from '../system/definitions.js';
import {
  type CarriedMessage,
  withEarlierConversation,
  withPostedMessages,
} from './carry-over.js';

/** Who wrote a message Pero sent: an Agent in its Session, or Pero itself. */
export type Author =
  { origin: 'agent'; agent: string; sessionId: number } | { origin: 'pero' };

/** A person's message to a Channel's Agent. */
export interface InboundEntry {
  channelId: number;
  /** The name of the Channel's Agent. */
  agentName: string;
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

/** A delivered Notification, as its Channel's history records it. */
export interface DeliveredEntry {
  channelId: number;
  notificationId: number;
  externalMessageId: string;
  text: string;
}

/**
 * The conversation a fresh Session starts from: what people, Agents, and
 * Workflows said there. Pero's notices are left out.
 */
const CARRIED_ORIGINS: readonly MessageOrigin[] = ['user', 'agent', 'workflow'];

/**
 * The origins each choice of a Workflow's history input reads. Workflow
 * messages are left out, so a Workflow never reads its own answers back.
 */
const WINDOW_ORIGINS: Record<HistoryMessages, readonly MessageOrigin[]> = {
  people: ['user'],
  all: ['user', 'agent'],
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
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly definitions: Definitions,
  ) {}

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
        agentName: author.origin === 'agent' ? author.agent : null,
        sessionId: author.origin === 'agent' ? author.sessionId : null,
        senderId: null,
      }),
    );
  }

  /**
   * Records delivered Notification `notificationId` inside the caller's
   * transaction, which marks it delivered. A Notification is recorded once:
   * a second row for it is refused.
   */
  async recordDeliveredWithin(
    manager: EntityManager,
    entry: DeliveredEntry,
  ): Promise<void> {
    await manager.getRepository(Message).insert({
      ...entry,
      direction: 'out',
      origin: 'workflow',
      agentName: null,
      sessionId: null,
      senderId: null,
    });
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
   * with, inside the caller's transaction: none from before `/new`.
   */
  async channelsWithHistoryWithin(
    manager: EntityManager,
    channelIds: readonly number[],
  ): Promise<Set<number>> {
    if (channelIds.length === 0) return new Set();
    const rows = await manager
      .getRepository(Message)
      .createQueryBuilder('message')
      .innerJoin('message.channel', 'channel')
      .select('DISTINCT message.channelId', 'channelId')
      .where('message.channelId IN (:...channelIds)', { channelIds })
      .andWhere('message.id > COALESCE(channel.contextFromMessageId, 0)')
      .andWhere('message.origin IN (:...origins)', {
        origins: CARRIED_ORIGINS,
      })
      .getRawMany<{ channelId: number }>();
    return new Set(rows.map((row) => Number(row.channelId)));
  }

  /**
   * The Channel's latest `limit` messages, oldest first, with the Workflow
   * run of each Workflow message, inside the caller's transaction.
   */
  async latestWithin(
    manager: EntityManager,
    channelId: number,
    limit: number,
  ): Promise<Message[]> {
    const latest = await manager.getRepository(Message).find({
      where: { channelId },
      relations: { notification: { workflowRun: true } },
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
   * The messages of `window`, oldest first, with their Channel, inside the
   * caller's transaction. Pero's own notices are left out.
   */
  async windowWithin(
    manager: EntityManager,
    window: HistoryWindow,
  ): Promise<Message[]> {
    const query = manager
      .getRepository(Message)
      .createQueryBuilder('message')
      .innerJoinAndSelect('message.channel', 'channel')
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
   * The input a turn of message `messageId` in the Channel runs with.
   * Workflow messages posted there since the Channel's previous person's
   * message come first, so the owner can answer them. When `carryOver`
   * is set, as for a Session whose provider has none of the conversation
   * yet, the Channel's latest messages before those come ahead of them, up
   * to the `history-carryover` setting. Says how many of each it added.
   */
  async turnInputWithin(
    manager: EntityManager,
    channelId: number,
    messageId: number,
    input: string,
    { carryOver }: { carryOver: boolean },
  ): Promise<{ input: string; posted: number; carried: number }> {
    const { historyCarryover, timezone } = this.definitions.defaults();
    const floor = await contextFloorWithin(manager, channelId);
    const posted = await this.postedBeforeWithin(
      manager,
      channelId,
      messageId,
      floor,
    );
    let text = withPostedMessages(input, posted.map(carried), timezone);
    if (!carryOver || historyCarryover === 0) {
      return { input: text, posted: posted.length, carried: 0 };
    }
    // Up to the posted messages, which are already there.
    const latest = await withWorkflow(
      manager.getRepository(Message).createQueryBuilder('message'),
    )
      .where('message.channelId = :channelId', { channelId })
      .andWhere('message.id < :beforeId', {
        beforeId: posted[0]?.id ?? messageId,
      })
      .andWhere('message.id > :floor', { floor })
      .andWhere('message.origin IN (:...origins)', {
        origins: CARRIED_ORIGINS,
      })
      .orderBy('message.createdAt', 'DESC')
      .addOrderBy('message.id', 'DESC')
      .limit(historyCarryover)
      .getMany();
    text = withEarlierConversation(
      text,
      latest.reverse().map(carried),
      timezone,
    );
    return { input: text, posted: posted.length, carried: latest.length };
  }

  /**
   * The Workflow messages posted in the Channel before message `beforeId`
   * and after the person's message before it, and after `floor`, oldest
   * first.
   */
  private async postedBeforeWithin(
    manager: EntityManager,
    channelId: number,
    beforeId: number,
    floor: number,
  ): Promise<Message[]> {
    const messages = manager.getRepository(Message);
    const previous = await messages
      .createQueryBuilder('message')
      .select('MAX(message.id)', 'id')
      .where('message.channelId = :channelId', { channelId })
      .andWhere('message.id < :beforeId', { beforeId })
      .andWhere("message.origin = 'user'")
      .getRawOne<{ id: number | null }>();
    return withWorkflow(messages.createQueryBuilder('message'))
      .where('message.channelId = :channelId', { channelId })
      .andWhere('message.id < :beforeId', { beforeId })
      .andWhere('message.id > :afterId', {
        afterId: Math.max(Number(previous?.id ?? 0), floor),
      })
      .andWhere("message.origin = 'workflow'")
      .orderBy('message.id', 'ASC')
      .getMany();
  }
}

/**
 * The ID a Channel's context starts after, set by `/new`; 0 when it starts
 * with the whole history.
 */
async function contextFloorWithin(
  manager: EntityManager,
  channelId: number,
): Promise<number> {
  const channel = await manager.getRepository(Channel).findOne({
    select: { id: true, contextFromMessageId: true },
    where: { id: channelId },
  });
  return channel?.contextFromMessageId ?? 0;
}

/** `query` over messages, with the run each Workflow message came from. */
function withWorkflow(
  query: SelectQueryBuilder<Message>,
): SelectQueryBuilder<Message> {
  return query
    .leftJoinAndSelect('message.notification', 'notification')
    .leftJoinAndSelect('notification.workflowRun', 'run');
}

/** The name of the Workflow whose Notification `message` delivered. */
export function workflowOf(message: Message): string | null {
  return message.notification?.workflowRun?.workflowName ?? null;
}

/** `message` as a transcript shows it, with who wrote it. */
function carried(message: Message): CarriedMessage {
  let speaker: string;
  switch (message.origin) {
    case 'user':
      speaker = 'User';
      break;
    case 'workflow':
      speaker = `Workflow ${workflowOf(message) ?? '?'}`;
      break;
    default:
      speaker = message.agentName ?? 'Agent';
  }
  return { speaker, text: message.text, createdAt: message.createdAt };
}
