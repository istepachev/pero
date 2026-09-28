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
import { Agent } from './agent.entity.js';
import { Channel } from './channel.entity.js';
import { Session } from './session.entity.js';
import { oneOf } from './sql.js';

export const MESSAGE_DIRECTIONS = ['in', 'out'] as const;

export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/**
 * Who wrote a message: a person in the chat, the Channel's Agent, or Pero
 * itself, such as a welcome or a failure notice.
 */
export const MESSAGE_ORIGINS = ['user', 'agent', 'pero'] as const;

export type MessageOrigin = (typeof MESSAGE_ORIGINS)[number];

/**
 * One text message exchanged in a Channel: its history. Only the text sent
 * and received there; no reasoning, tool activity, or provider transcript.
 * Rows are ordered by ID, since `created_at` has whole seconds.
 */
@Entity('messages')
@Index('IDX_messages_channel_created_at', ['channelId', 'createdAt'])
@Index('IDX_messages_created_at', ['createdAt'])
@Check('CHK_messages_direction', oneOf('direction', MESSAGE_DIRECTIONS))
@Check('CHK_messages_origin', oneOf('origin', MESSAGE_ORIGINS))
// People write in; Agents and Pero write out.
@Check(
  'CHK_messages_origin_direction',
  `("direction" = 'in') = ("origin" = 'user')`,
)
@Check(
  'CHK_messages_agent_reply',
  `"origin" <> 'agent' OR ("agent_id" IS NOT NULL AND "session_id" IS NOT NULL)`,
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

  /** The Agent the message was to or from; null for Pero's own notices. */
  @Column({ name: 'agent_id', type: 'integer', nullable: true })
  agentId: number | null;

  @ManyToOne(() => Agent, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'agent_id',
    foreignKeyConstraintName: 'FK_messages_agent_id',
  })
  agent?: Agent | null;

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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
