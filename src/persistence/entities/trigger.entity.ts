import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { jsonObject, jsonTransformer } from '../json-transformer.js';
import { oneOf, TRIGGER_KINDS, type TriggerKind } from './sql.js';
import { Workflow } from './workflow.entity.js';

export { TRIGGER_KINDS, type TriggerKind };

/** A rule that starts a Workflow; removed along with its Workflow. */
@Entity('triggers')
@Index('IDX_triggers_workflow_id', ['workflowId'])
@Check('CHK_triggers_kind', oneOf('kind', TRIGGER_KINDS))
@Check('CHK_triggers_config_json', `json_valid("config_json")`)
export class Trigger {
  @PrimaryGeneratedColumn({ type: 'integer' })
  id: number;

  @Column({ name: 'workflow_id', type: 'integer' })
  workflowId: number;

  @ManyToOne(() => Workflow, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'workflow_id',
    foreignKeyConstraintName: 'FK_triggers_workflow_id',
  })
  workflow?: Workflow;

  @Column({ type: 'text' })
  kind: TriggerKind;

  /** Kind-specific settings, such as a cron expression. JSON text. */
  @Column({
    name: 'config_json',
    type: 'text',
    transformer: jsonTransformer(jsonObject),
  })
  config: Record<string, unknown>;

  /** IANA time zone for computing future occurrences. */
  @Column({ type: 'text', nullable: true })
  timezone: string | null;

  /**
   * When a manual Trigger last started a run. A schedule's times are in
   * `schedules`.
   */
  @Column({ name: 'last_run_at', type: 'datetime', nullable: true })
  lastRunAt: Date | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;
}
