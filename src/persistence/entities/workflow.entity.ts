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
import { oneOf } from './sql.js';

/** `serial`: at most one active run per Workflow. */
export const CONCURRENCY_POLICIES = ['serial'] as const;

export type ConcurrencyPolicy = (typeof CONCURRENCY_POLICIES)[number];

/** A saved definition of autonomous work. */
@Entity('workflows')
@Index('UQ_workflows_name', ['name'], { unique: true })
@Index('IDX_workflows_agent_id', ['agentId'])
@Check(
  'CHK_workflows_concurrency_policy',
  oneOf('concurrency_policy', CONCURRENCY_POLICIES),
)
export class Workflow {
  @PrimaryGeneratedColumn({ type: 'integer' })
  id: number;

  @Column({ type: 'text' })
  name: string;

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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
