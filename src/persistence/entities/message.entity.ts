import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Channel } from './channel.entity.js';
import { Notification } from './notification.entity.js';
import { Session } from './session.entity.js';
import {
  MESSAGE_DIRECTIONS,
  MESSAGE_ORIGINS,
  type MessageDirection,
  type MessageOrigin,
  oneOf,
} from './sql.js';

export {
  MESSAGE_DIRECTIONS,
  MESSAGE_ORIGINS,
  type MessageDirection,
  type MessageOrigin,
};

/**
 * One text message exchanged in a Channel: its history. Only the text sent
 * and received there; no reasoning, tool activity, or provider transcript.
 * Rows are ordered by ID, since `created_at` has whole seconds.
 */
@Entity('messages')
@Index('IDX_messages_channel_created_at', ['channelId', 'createdAt'])
@Index('IDX_messages_created_at', ['createdAt'])
// A delivered Notification is recorded once.
@Index('UQ_messages_notification_id', ['notificationId'], { unique: true })
@Check('CHK_messages_direction', oneOf('direction', MESSAGE_DIRECTIONS))
@Check('CHK_messages_origin', oneOf('origin', MESSAGE_ORIGINS))
// People write in; Agents and Pero write out.
@Check(
  'CHK_messages_origin_direction',
  `("direction" = 'in') = ("origin" = 'user')`,
)
@Check(
  'CHK_messages_agent_reply',
  `"origin" <> 'agent' OR ("agent_name" IS NOT NULL AND "session_id" IS NOT NULL)`,
)
// A Workflow's message is its delivered Notification, and only that.
@Check(
  'CHK_messages_workflow',
  `("origin" = 'workflow') = ("notification_id" IS NOT NULL)`,
)
export class Message {
  @PrimaryGeneratedColumn({ type: 'integer' })
  id: number;

  @Column({ name: 'channel_id', type: 'integer' })
  channelId: number;

  @ManyToOne(() => Channel, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'channel_id',
    foreignKeyConstraintName: 'FK_messages_channel_id',
  })
  channel?: Channel;

  /**
   * The name of the Agent the message was to or from; null for Pero's own
   * notices and a Workflow's.
   */
  @Column({ name: 'agent_name', type: 'text', nullable: true })
  agentName: string | null;

  /**
   * The Session the message belongs to. A person's message gets it when its
   * turn starts, so it stays null for a turn that never ran.
   */
  @Column({ name: 'session_id', type: 'integer', nullable: true })
  sessionId: number | null;

  @ManyToOne(() => Session, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'session_id',
    foreignKeyConstraintName: 'FK_messages_session_id',
  })
  session?: Session | null;

  @Column({ type: 'text' })
  direction: MessageDirection;

  @Column({ type: 'text' })
  origin: MessageOrigin;

  /**
   * The integration's ID for the message, as a string; the first part's ID
   * when the adapter split it into several.
   */
  @Column({ name: 'external_message_id', type: 'text' })
  externalMessageId: string;

  /** The integration's ID for who sent it; null for what Pero sent. */
  @Column({ name: 'sender_id', type: 'text', nullable: true })
  senderId: string | null;

  @Column({ type: 'text' })
  text: string;

  /** The Notification this message delivered; set only for a Workflow's. */
  @Column({ name: 'notification_id', type: 'integer', nullable: true })
  notificationId: number | null;

  @ManyToOne(() => Notification, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'notification_id',
    foreignKeyConstraintName: 'FK_messages_notification_id',
  })
  notification?: Notification | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
