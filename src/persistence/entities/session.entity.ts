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
import { PROVIDERS, type Provider } from '../../config/provider-options.js';
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
@Check('CHK_sessions_provider', oneOf('provider', PROVIDERS))
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

  /*
   * A Session resumes only while the Agent still has the provider and the
   * effective working directory it began with: another provider cannot read
   * the session ID, and a provider session belongs to its folder. Model,
   * effort, and instructions may change within a Session.
   */

  /** The provider the Session runs on. */
  @Column({ type: 'text' })
  provider: Provider;

  /** The absolute folder the Session runs in. */
  @Column({ name: 'working_directory', type: 'text' })
  workingDirectory: string;

  @Column({ type: 'text', default: 'active' })
  status: SessionStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
