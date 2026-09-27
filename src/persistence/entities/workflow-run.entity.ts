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
import { jsonObject, jsonTransformer } from '../json-transformer.js';
import { oneOf } from './sql.js';
import { Trigger } from './trigger.entity.js';
import { Workflow } from './workflow.entity.js';

export const RUN_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/** One execution of a Workflow. */
@Entity('workflow_runs')
// One run per trigger occurrence, however often it is created.
@Index('UQ_workflow_runs_trigger_key', ['workflowId', 'triggerKey'], {
  unique: true,
})
@Index('IDX_workflow_runs_status', ['status', 'createdAt'])
@Index('IDX_workflow_runs_trigger_id', ['triggerId'])
@Check('CHK_workflow_runs_status', oneOf('status', RUN_STATUSES))
@Check('CHK_workflow_runs_attempt', `"attempt" >= 1`)
@Check(
  'CHK_workflow_runs_execution_config_json',
  `json_valid("execution_config_json")`,
)
@Check('CHK_workflow_runs_result_json', `json_valid("result_json")`)
export class WorkflowRun {
  @PrimaryGeneratedColumn({ type: 'integer' })
  id: number;

  @Column({ name: 'workflow_id', type: 'integer' })
  workflowId: number;

  @ManyToOne(() => Workflow, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'workflow_id',
    foreignKeyConstraintName: 'FK_workflow_runs_workflow_id',
  })
  workflow?: Workflow;

  /** The Trigger that created the run; null once removed, or if none did. */
  @Column({ name: 'trigger_id', type: 'integer', nullable: true })
  triggerId: number | null;

  @ManyToOne(() => Trigger, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'trigger_id',
    foreignKeyConstraintName: 'FK_workflow_runs_trigger_id',
  })
  trigger?: Trigger | null;

  /** Deduplication key of the occurrence that created the run. */
  @Column({ name: 'trigger_key', type: 'text' })
  triggerKey: string;

  @Column({ type: 'text', default: 'pending' })
  status: RunStatus;

  @Column({ type: 'integer', default: 1 })
  attempt: number;

  /**
   * Provider, provider options, and resolved working directory, captured
   * when the run is claimed. JSON text.
   */
  @Column({
    name: 'execution_config_json',
    type: 'text',
    nullable: true,
    transformer: jsonTransformer(jsonObject),
  })
  executionConfig: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'started_at', type: 'datetime', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'finished_at', type: 'datetime', nullable: true })
  finishedAt: Date | null;

  /** JSON text. */
  @Column({
    name: 'result_json',
    type: 'text',
    nullable: true,
    transformer: jsonTransformer(jsonObject),
  })
  result: Record<string, unknown> | null;

  @Column({ name: 'error_text', type: 'text', nullable: true })
  errorText: string | null;
}
