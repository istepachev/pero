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
import { Agent } from './agent.entity.js';
import { INTEGRATION_KINDS, type IntegrationKind, oneOf } from './sql.js';

/** A conversation endpoint, such as one Telegram topic, and its Agent. */
@Entity('channels')
@Index('UQ_channels_key', ['integrationKind', 'externalKey'], {
  unique: true,
})
@Index('IDX_channels_agent_id', ['agentId'])
@Check(
  'CHK_channels_integration_kind',
  oneOf('integration_kind', INTEGRATION_KINDS),
)
@Check('CHK_channels_address_json', `json_valid("address_json")`)
export class Channel {
  @PrimaryGeneratedColumn({ type: 'integer' })
  id: number;

  @Column({ name: 'integration_kind', type: 'text' })
  integrationKind: IntegrationKind;

  /**
   * The address in one string, unique per integration. Telegram derives it
   * from the chat ID and the normalized topic ID.
   */
  @Column({ name: 'external_key', type: 'text' })
  externalKey: string;

  /**
   * The integration's structured address. Telegram IDs are strings, so no
   * 64-bit ID loses precision as a JavaScript number. JSON text.
   */
  @Column({
    name: 'address_json',
    type: 'text',
    transformer: jsonTransformer(jsonObject),
  })
  address: Record<string, unknown>;

  /** The topic or chat name, for display; null when the integration has none. */
  @Column({ type: 'text', nullable: true })
  title: string | null;

  @Column({ name: 'agent_id', type: 'integer' })
  agentId: number;

  @ManyToOne(() => Agent, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'agent_id',
    foreignKeyConstraintName: 'FK_channels_agent_id',
  })
  agent?: Agent;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
