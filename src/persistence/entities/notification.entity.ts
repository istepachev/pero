import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { jsonObject, jsonTransformer } from '../json-transformer.js';
import { Channel } from './channel.entity.js';
import { oneOf } from './sql.js';
import { WorkflowRun } from './workflow-run.entity.js';

export const NOTIFICATION_STATUSES = [
  'pending',
  'delivered',
  'failed',
] as const;

export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** A durable request to deliver a message to a Channel. */
@Entity('notifications')
// One Notification per run and Channel.
@Index('UQ_notifications_target', ['workflowRunId', 'channelId'], {
  unique: true,
})
@Index('IDX_notifications_delivery', ['status', 'nextAttemptAt'])
@Index('IDX_notifications_channel_id', ['channelId'])
@Check('CHK_notifications_status', oneOf('status', NOTIFICATION_STATUSES))
@Check('CHK_notifications_payload', `json_valid("payload")`)
@Check('CHK_notifications_attempt', `"attempt" >= 0`)
export class Notification {
  @PrimaryGeneratedColumn({ type: 'integer' })
  id: number;

  @Column({ name: 'workflow_run_id', type: 'integer' })
  workflowRunId: number;

  @ManyToOne(() => WorkflowRun, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'workflow_run_id',
    foreignKeyConstraintName: 'FK_notifications_workflow_run_id',
  })
  workflowRun?: WorkflowRun;

  @Column({ name: 'channel_id', type: 'integer' })
  channelId: number;

  @ManyToOne(() => Channel, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'channel_id',
    foreignKeyConstraintName: 'FK_notifications_channel_id',
  })
  channel?: Channel;

  @Column({ type: 'text', default: 'pending' })
  status: NotificationStatus;

  /** The rendered message. JSON text. */
  @Column({ type: 'text', transformer: jsonTransformer(jsonObject) })
  payload: Record<string, unknown>;

  /** Delivery attempts made so far. */
  @Column({ type: 'integer', default: 0 })
  attempt: number;

  @Column({ name: 'next_attempt_at', type: 'datetime', nullable: true })
  nextAttemptAt: Date | null;

  /** The delivered message's ID, as a string. */
  @Column({ name: 'provider_message_id', type: 'text', nullable: true })
  providerMessageId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
