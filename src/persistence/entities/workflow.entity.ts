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
import { SLUG_MAX_LENGTH } from '../../config/slug.js';
import { Agent } from './agent.entity.js';
import {
  CONCURRENCY_POLICIES,
  type ConcurrencyPolicy,
  isSlug,
  oneOf,
} from './sql.js';

export { CONCURRENCY_POLICIES, type ConcurrencyPolicy };

/** A saved definition of autonomous work. */
@Entity('workflows')
@Index('UQ_workflows_name', ['name'], { unique: true })
@Check('CHK_workflows_name', isSlug('name', SLUG_MAX_LENGTH))
@Index('IDX_workflows_agent_id', ['agentId'])
@Check(
  'CHK_workflows_concurrency_policy',
  oneOf('concurrency_policy', CONCURRENCY_POLICIES),
)
export class Workflow {
  @PrimaryGeneratedColumn({ type: 'integer' })
  id: number;

  /** The slug the CLI addresses the Workflow by. */
  @Column({ type: 'text' })
  name: string;

  /** Display name; null shows `name`. */
  @Column({ type: 'text', nullable: true })
  title: string | null;

  @Column({ name: 'agent_id', type: 'integer' })
  agentId: number;

  @ManyToOne(() => Agent, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'agent_id',
    foreignKeyConstraintName: 'FK_workflows_agent_id',
  })
  agent?: Agent;

  /** The input each run sends to the Agent. */
  @Column({ name: 'input_template', type: 'text' })
  inputTemplate: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ name: 'concurrency_policy', type: 'text', default: 'serial' })
  concurrencyPolicy: ConcurrencyPolicy;

  /**
   * How many times a run of it may start in all. A run Pero stopped before
   * it finished is queued again on startup while its attempt is below this;
   * 1 leaves it for the owner.
   */
  @Column({ name: 'max_attempts', type: 'integer', default: 1 })
  maxAttempts: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
