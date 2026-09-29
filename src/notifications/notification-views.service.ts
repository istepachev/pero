import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, FindOptionsWhere } from 'typeorm';
import { AllowedChatsService } from '../channels/allowed-chats.service.js';
import { ChannelSender } from '../channels/channel-sender.js';
import { NotFoundError } from '../common/errors.js';
import type {
  NotificationDetails,
  NotificationView,
  ParsedControlParams,
} from '../control/protocol.js';
import { ComponentHealth } from '../health/component-health.js';
import { Notification } from '../persistence/entities/notification.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { findWorkflow } from '../workflows/workflows.service.js';
import {
  MAX_DELIVERY_ATTEMPTS,
  NotificationDelivery,
} from './notification-delivery.js';
import { notificationPayloadSchema } from './run-notifications.js';

/** What a Notification view needs loaded with it. */
export const NOTIFICATION_RELATIONS = {
  channel: true,
  workflowRun: { workflow: true },
} as const;

/** Notifications as the CLI shows them, with what delivery needs. */
@Injectable()
export class NotificationViews {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sender: ChannelSender,
    private readonly allowedChats: AllowedChatsService,
    private readonly delivery: NotificationDelivery,
    private readonly health: ComponentHealth,
  ) {}

  /** The latest Notifications that match `filter`, newest first. */
  list(
    filter: ParsedControlParams<'notifications.list'>,
  ): Promise<NotificationView[]> {
    return inTransaction(this.dataSource, async (manager) => {
      const where: FindOptionsWhere<Notification> = {};
      if (filter.status !== undefined) where.status = filter.status;
      if (filter.channel !== undefined) where.channelId = filter.channel;
      if (filter.run !== undefined) where.workflowRunId = filter.run;
      if (filter.workflow !== undefined) {
        const { id } = await findWorkflow(manager, filter.workflow);
        where.workflowRun = { workflowId: id };
      }
      const notifications = await manager.getRepository(Notification).find({
        where,
        relations: NOTIFICATION_RELATIONS,
        order: { id: 'DESC' },
        take: filter.limit,
      });
      return notifications.map(notificationView);
    });
  }

  /**
   * Notification `id` with its message, what stands in the way of its
   * delivery, and whether it is being delivered; `NotFoundError` if none.
   */
  async details(id: number): Promise<NotificationDetails> {
    const notification = await this.dataSource
      .getRepository(Notification)
      .findOne({ where: { id }, relations: NOTIFICATION_RELATIONS });
    if (notification === null) {
      throw new NotFoundError(`No Notification with ID ${id}`);
    }
    const payload = notificationPayloadSchema.safeParse(notification.payload);
    return {
      ...notificationView(notification),
      text: payload.success ? payload.data.text : null,
      chatAllowed: await this.chatAllowed(notification),
      integrationProblem: this.integrationProblem(notification),
      delivering: this.delivery.isDelivering(id),
    };
  }

  /** What its integration's health reports while not `ok`. */
  private integrationProblem(notification: Notification): string | null {
    // The foreign key guarantees the Channel.
    const status = this.health.get(notification.channel!.integrationKind);
    if (status === undefined || status.state === 'ok') return null;
    return status.detail ?? status.state;
  }

  private async chatAllowed(
    notification: Notification,
  ): Promise<boolean | null> {
    // The foreign key guarantees the Channel.
    const { integrationKind, address } = notification.channel!;
    let chatKey: string;
    try {
      chatKey = this.sender.chatKey(integrationKind, address);
    } catch {
      // Its adapter is not connected.
      return null;
    }
    return (await this.allowedChats.find(integrationKind, chatKey)) !== null;
  }
}

/**
 * A Notification as the CLI lists it; `notification` is loaded with
 * `NOTIFICATION_RELATIONS`.
 */
export function notificationView(notification: Notification): NotificationView {
  // The foreign keys guarantee the Channel, the run, and its Workflow.
  const channel = notification.channel!;
  return {
    id: notification.id,
    runId: notification.workflowRunId,
    workflow: notification.workflowRun!.workflow!.name,
    channel: {
      id: channel.id,
      integrationKind: channel.integrationKind,
      key: channel.externalKey,
      title: channel.title,
      enabled: channel.enabled,
    },
    status: notification.status,
    attempt: notification.attempt,
    maxAttempts: MAX_DELIVERY_ATTEMPTS,
    nextAttemptAt: notification.nextAttemptAt?.toISOString() ?? null,
    lastError: notification.lastError,
    providerMessageId: notification.providerMessageId,
    createdAt: notification.createdAt.toISOString(),
    updatedAt: notification.updatedAt.toISOString(),
  };
}
