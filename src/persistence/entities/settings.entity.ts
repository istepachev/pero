import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  type Provider,
  type ProviderDefaults,
  providerDefaultsSchema,
} from '../../config/provider-options.js';
import { jsonTransformer } from '../json-transformer.js';
import { Agent } from './agent.entity.js';

/** The ID of the one settings row. */
export const SETTINGS_ID = 1;

// Column types are explicit: nullable unions emit no usable design metadata.
/** Installation defaults and operational limits; a singleton row. */
@Entity('settings')
@Check('CHK_settings_singleton', `"id" = 1`)
@Check(
  'CHK_settings_default_provider',
  `"default_provider" IN ('claude', 'codex')`,
)
@Check('CHK_settings_provider_defaults', `json_valid("provider_defaults")`)
@Check('CHK_settings_max_concurrent_runs', `"max_concurrent_runs" >= 1`)
@Check('CHK_settings_history_carryover', `"history_carryover" >= 0`)
export class Settings {
  @PrimaryColumn({ type: 'integer' })
  id: number;

  /** Provider copied into new Agents. */
  @Column({ name: 'default_provider', type: 'text', default: 'claude' })
  defaultProvider: Provider;

  /**
   * Per-provider options (model, effort) copied into new Agents; a null
   * option means the provider's own default. JSON text.
   */
  @Column({
    name: 'provider_defaults',
    type: 'text',
    transformer: jsonTransformer(providerDefaultsSchema),
  })
  providerDefaults: ProviderDefaults;

  /** Folder used by every Agent without its own; null until setup fills it. */
  @Column({ name: 'default_working_directory', type: 'text', nullable: true })
  defaultWorkingDirectory: string | null;

  /** Text placed before each opted-in Agent's instructions; null means none. */
  @Column({ name: 'shared_instructions', type: 'text', nullable: true })
  sharedInstructions: string | null;

  /**
   * The Agent primary Channels (a General topic, a group without topics, or
   * a direct chat) are assigned; null until the first one creates `main`.
   */
  @Column({ name: 'main_agent_id', type: 'integer', nullable: true })
  mainAgentId: number | null;

  @ManyToOne(() => Agent, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'main_agent_id',
    foreignKeyConstraintName: 'FK_settings_main_agent_id',
  })
  mainAgent?: Agent;

  /**
   * How many of a Channel's latest messages a fresh Session that replaces
   * another starts with; 0 turns carry-over off.
   */
  @Column({ name: 'history_carryover', type: 'integer', default: 50 })
  historyCarryover: number;

  /** IANA time zone. */
  @Column({ type: 'text' })
  timezone: string;

  /** Upper bound on Workflow Runs executing at once. */
  @Column({ name: 'max_concurrent_runs', type: 'integer', default: 2 })
  maxConcurrentRuns: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
