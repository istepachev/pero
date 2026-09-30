import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { Channel } from './channel.entity.js';

/**
 * The Agent a Channel of a legacy data directory is assigned to, and
 * whether the Channel is enabled. In a workspace, notes' `topics` route
 * Channels instead; this keeps a legacy data directory answering as before,
 * and tells `pero migrate` which topics each Agent claims. It goes with
 * legacy data directories, after 0.2.0.
 */
@Entity('legacy_channel_agents')
export class LegacyChannelAgent {
  @PrimaryColumn({ name: 'channel_id', type: 'integer' })
  channelId: number;

  @OneToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'channel_id',
    foreignKeyConstraintName: 'FK_legacy_channel_agents_channel_id',
  })
  channel?: Channel;

  /** The name of the Agent that answers there. */
  @Column({ name: 'agent_name', type: 'text' })
  agentName: string;

  /** A disabled Channel ignores messages. */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;
}
