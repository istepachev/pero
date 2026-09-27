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
import { Agent } from './agent.entity.js';
import { Channel } from './channel.entity.js';
import { oneOf } from './sql.js';

export const SESSION_STATUSES = ['active', 'closed'] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Conversational context of a Channel with an Agent. */
@Entity('sessions')
// At most one active Session per Channel and Agent; also the lookup index.
@Index('UQ_sessions_active', ['channelId', 'agentId'], {
  unique: true,
  where: `"status" = 'active'`,
})
@Index('IDX_sessions_agent_id', ['agentId'])
@Check('CHK_sessions_status', oneOf('status', SESSION_STATUSES))
export class Session {
  @PrimaryGeneratedColumn({ type: 'integer' })
  id: number;

  @Column({ name: 'agent_id', type: 'integer' })
  agentId: number;

  @ManyToOne(() => Agent, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'agent_id',
    foreignKeyConstraintName: 'FK_sessions_agent_id',
  })
  agent?: Agent;

  @Column({ name: 'channel_id', type: 'integer' })
  channelId: number;

  @ManyToOne(() => Channel, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'channel_id',
    foreignKeyConstraintName: 'FK_sessions_channel_id',
  })
  channel?: Channel;

  /** The provider's opaque session or thread ID; null before the first turn. */
  @Column({ name: 'provider_session_id', type: 'text', nullable: true })
  providerSessionId: string | null;

  /** The Agent's execution config version when the Session began. */
  @Column({ name: 'agent_config_version', type: 'integer' })
  agentConfigVersion: number;

  @Column({ type: 'text', default: 'active' })
  status: SessionStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
