import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, type EntityManager, LessThanOrEqual } from 'typeorm';
import { AllowedChatsService } from '../channels/allowed-chats.service.js';
import type { SentMessage } from '../channels/channel-adapter.js';
import { ChannelSender } from '../channels/channel-sender.js';
import { MessageHistory } from '../history/message-history.service.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Notification } from '../persistence/entities/notification.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { notificationPayloadSchema } from './run-notifications.js';

/** How often the worker looks for Notifications due for delivery. */
export const DELIVERY_TICK_MS = 5_000;

/**
 * How long a Notification waits after each failed attempt: the first
 * retry comes 30 seconds after the first attempt, and the last about a day
 * after it. Telegram being down that long fails it.
 */
export const DELIVERY_BACKOFF_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000,
  8 * 60 * 60_000,
  8 * 60 * 60_000,
] as const;

/** Attempts in all before a Notification is `failed`. */
export const MAX_DELIVERY_ATTEMPTS = DELIVERY_BACKOFF_MS.length + 1;

/** The most Notifications one tick tries to deliver. */
const BATCH_SIZE = 50;

/** The longest failure reason kept on a Notification. */
const MAX_ERROR_LENGTH = 1_000;

/** Why a Notification to a chat that is not allowed was not sent. */
export const NOT_ALLOWED = 'the chat is no longer allowed';

/** How long to wait after failed attempt `attempt` (1 for the first). */
export function retryDelay(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), DELIVERY_BACKOFF_MS.length);
  return DELIVERY_BACKOFF_MS[index - 1]!;
}

/** A Notification taken for one attempt, with where and what to send. */
interface Claim {
  id: number;
  runId: number;
  attempt: number;
  retryAt: Date;
  channel: Pick<Channel, 'id' | 'integrationKind' | 'address'>;
  /** The text to send; null when the payload holds none. */
  text: string | null;
}

/**
 * Delivers pending Notifications to their Channels, one at a time, and
 * records each delivered one in its Channel's history. A failed attempt
 * waits longer each time, up to `MAX_DELIVERY_ATTEMPTS`, and a Notification
 * that runs out of attempts, or targets a chat that is no longer allowed,
 * stays `failed` for the owner to see. SQLite holds the queue, so delivery
 * picks up after a restart where it stopped.
 *
 * Delivery is at least once: should Pero stop between sending and
 * recording, the message is sent again after the backoff, though history
 * records it once.
 */
@Injectable()
export class NotificationDelivery implements BeforeApplicationShutdown {
  private readonly logger = new Logger('Notifications');
  /** The tick under way, if any. */
  private current: Promise<void> | null = null;
  /** Notifications being sent, which no overlapping tick may take. */
  private readonly sending = new Set<number>();
  private stopping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sender: ChannelSender,
    private readonly allowedChats: AllowedChatsService,
    private readonly history: MessageHistory,
  ) {}

  /** Lets a tick under way finish before the database closes. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.current;
  }

  @Interval('notification-delivery', DELIVERY_TICK_MS)
  onInterval(): void {
    void this.poll();
  }

  /**
   * Makes one attempt at each Notification due by `now`, oldest due
   * first. Never throws; each failure is recorded on its Notification.
   * The first tick comes an interval after startup, once the adapters
   * have connected.
   */
  async tick(now: Date = new Date()): Promise<void> {
    const due = await this.dataSource.getRepository(Notification).find({
      select: { id: true },
      where: { status: 'pending', nextAttemptAt: LessThanOrEqual(now) },
      order: { nextAttemptAt: 'ASC', id: 'ASC' },
      take: BATCH_SIZE,
    });
    for (const { id } of due) {
      if (this.stopping) return;
      try {
        await this.attempt(id, now);
      } catch (error) {
        this.logger.error(
          `Could not deliver Notification ${id}: ${describe(error)}`,
        );
      }
    }
  }

  /** One tick at a time, skipped while stopping; never throws. */
  private poll(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.current ??= this.tick()
      .catch((error: unknown) => {
        this.logger.error(
          `Could not look for Notifications to deliver: ${describe(error)}`,
        );
      })
      .finally(() => {
        this.current = null;
      });
    return this.current;
  }

  private async attempt(id: number, now: Date): Promise<void> {
    if (this.sending.has(id)) return;
    this.sending.add(id);
    try {
      await this.claimAndSend(id, now);
    } finally {
      this.sending.delete(id);
    }
  }

  private async claimAndSend(id: number, now: Date): Promise<void> {
    const claim = await inTransaction(this.dataSource, (manager) =>
      this.claimWithin(manager, id, now),
    );
    if (claim === null) return;
    const { channel } = claim;
    if (claim.text === null) {
      await this.fail(claim, 'its payload holds no message', true);
      return;
    }
    let sent: SentMessage;
    try {
      const chatKey = this.sender.chatKey(
        channel.integrationKind,
        channel.address,
      );
      if (
        (await this.allowedChats.find(channel.integrationKind, chatKey)) ===
        null
      ) {
        await this.fail(claim, NOT_ALLOWED, true);
        return;
      }
      sent = await this.sender.send(channel.integrationKind, channel.address, {
        text: claim.text,
      });
    } catch (error) {
      await this.fail(claim, describe(error), false);
      return;
    }
    await this.delivered(claim, claim.text, sent);
  }

  /**
   * Takes Notification `id` for an attempt, unless it is no longer pending
   * and due. Its next attempt is set as if this one fails, so a Pero that
   * stops mid-send tries again only after the backoff.
   */
  private async claimWithin(
    manager: EntityManager,
    id: number,
    now: Date,
  ): Promise<Claim | null> {
    const notifications = manager.getRepository(Notification);
    const notification = await notifications.findOne({
      where: { id },
      relations: { channel: true },
    });
    if (
      notification === null ||
      notification.status !== 'pending' ||
      notification.nextAttemptAt === null ||
      notification.nextAttemptAt > now
    ) {
      return null;
    }
    const attempt = notification.attempt + 1;
    const retryAt = new Date(now.getTime() + retryDelay(attempt));
    await notifications.update(id, { attempt, nextAttemptAt: retryAt });
    const payload = notificationPayloadSchema.safeParse(notification.payload);
    return {
      id,
      runId: notification.workflowRunId,
      attempt,
      retryAt,
      // The foreign key guarantees the Channel.
      channel: notification.channel!,
      text: payload.success ? payload.data.text : null,
    };
  }

  /**
   * Marks the Notification delivered and records it in its Channel's
   * history, together. Should that fail, the message goes out again at the
   * retry time and is recorded then.
   */
  private async delivered(
    claim: Claim,
    text: string,
    sent: SentMessage,
  ): Promise<void> {
    const where = describeClaim(claim);
    try {
      await inTransaction(this.dataSource, async (manager) => {
        await manager.getRepository(Notification).update(claim.id, {
          status: 'delivered',
          providerMessageId: sent.messageId,
          nextAttemptAt: null,
          lastError: null,
        });
        await this.history.recordDeliveredWithin(manager, {
          channelId: claim.channel.id,
          notificationId: claim.id,
          externalMessageId: sent.messageId,
          text,
        });
      });
    } catch (error) {
      this.logger.error(
        `Delivered ${where} but could not record it; it is sent again at ` +
          `${claim.retryAt.toISOString()}: ${describe(error)}`,
      );
      return;
    }
    this.logger.log(`Delivered ${where} on attempt ${claim.attempt}`);
  }

  /**
   * Records why an attempt failed. The Notification stays pending for its
   * retry unless it is out of attempts or `final`, which fails it at once.
   */
  private async fail(
    claim: Claim,
    reason: string,
    final: boolean,
  ): Promise<void> {
    const lastError =
      reason.length > MAX_ERROR_LENGTH
        ? `${reason.slice(0, MAX_ERROR_LENGTH - 1)}…`
        : reason;
    const failed = final || claim.attempt >= MAX_DELIVERY_ATTEMPTS;
    await inTransaction(this.dataSource, (manager) =>
      manager
        .getRepository(Notification)
        .update(
          claim.id,
          failed
            ? { lastError, status: 'failed', nextAttemptAt: null }
            : { lastError },
        ),
    );
    const where = describeClaim(claim);
    if (failed) {
      this.logger.warn(
        `Could not deliver ${where}; it failed after ${claim.attempt} ` +
          `attempt(s): ${reason}`,
      );
    } else {
      this.logger.warn(
        `Attempt ${claim.attempt} to deliver ${where} failed; retrying at ` +
          `${claim.retryAt.toISOString()}: ${reason}`,
      );
    }
  }
}

function describeClaim(claim: Claim): string {
  return `Notification ${claim.id} of run ${claim.runId} to Channel ${claim.channel.id}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
