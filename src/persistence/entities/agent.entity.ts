import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { SLUG_MAX_LENGTH } from '../../config/slug.js';
import {
  PROVIDERS,
  type Provider,
  type ProviderOptions,
  providerOptionsSchema,
} from '../../config/provider-options.js';
import { jsonObject, jsonTransformer } from '../json-transformer.js';
import { isSlug, oneOf } from './sql.js';

/** A saved definition of behavior; not a running process. */
@Entity('agents')
@Index('UQ_agents_name', ['name'], { unique: true })
@Check('CHK_agents_name', isSlug('name', SLUG_MAX_LENGTH))
@Check('CHK_agents_provider', oneOf('provider', PROVIDERS))
@Check('CHK_agents_provider_options', `json_valid("provider_options")`)
@Check('CHK_agents_tool_policy_json', `json_valid("tool_policy_json")`)
export class Agent {
  @PrimaryGeneratedColumn({ type: 'integer' })
  id: number;

  /** The slug the CLI addresses the Agent by. */
  @Column({ type: 'text' })
  name: string;

  /** Display name; null shows `name`. */
  @Column({ type: 'text', nullable: true })
  title: string | null;

  @Column({ type: 'text' })
  provider: Provider;

  /** The Agent's own instructions; null means none. */
  @Column({ type: 'text', nullable: true })
  instructions: string | null;

  /**
   * Model and effort for `provider`; a null option means the provider's own
   * default. JSON text.
   */
  @Column({
    name: 'provider_options',
    type: 'text',
    transformer: jsonTransformer(providerOptionsSchema),
  })
  providerOptions: ProviderOptions;

  /** The Agent's own absolute folder; null follows the default. */
  @Column({ name: 'working_directory', type: 'text', nullable: true })
  workingDirectory: string | null;

  /** Whether the shared instructions precede the Agent's own. */
  @Column({ name: 'use_shared_instructions', type: 'boolean', default: true })
  useSharedInstructions: boolean;

  /** Lets a Codex Agent work in a folder that is not a Git repository. */
  @Column({
    name: 'codex_skip_git_repo_check',
    type: 'boolean',
    default: false,
  })
  codexSkipGitRepoCheck: boolean;

  /** Tools the Agent may use. JSON text. */
  @Column({
    name: 'tool_policy_json',
    type: 'text',
    transformer: jsonTransformer(jsonObject),
  })
  toolPolicy: Record<string, unknown>;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
