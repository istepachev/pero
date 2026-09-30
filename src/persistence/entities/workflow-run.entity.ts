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
import { oneOf, RUN_STATUSES, type RunStatus } from './sql.js';
import { Trigger } from './trigger.entity.js';

export { RUN_STATUSES, type RunStatus };

/** One execution of a Workflow. */
@Entity('workflow_runs')
// One run per trigger occurrence, however often it is created.
@Index('UQ_workflow_runs_trigger_key', ['workflowName', 'triggerKey'], {
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

  /** The name of the Workflow it runs. */
  @Column({ name: 'workflow_name', type: 'text' })
  workflowName: string;

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
   * How many later times of its schedule came due without a run of their
   * own and were coalesced into this one: missed while Pero was down, or
   * while this run waited to start.
   */
  @Column({ name: 'skipped_count', type: 'integer', default: 0 })
  skippedCount: number;

  /**
   * What the run executes with, captured when the executor claims it: the
   * Agent's provider, options, resolved folder, composed instructions, and
   * tool policy, and the input. See `executionSnapshotSchema`. JSON text.
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

  /** The Agent's answer (`text`) and its provider session ID. JSON text. */
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
