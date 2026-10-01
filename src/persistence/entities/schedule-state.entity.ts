import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Where a schedule of a Workflow stands: when it next comes due, and when
 * it last started a run. The schedule itself is a definition; its
 * fingerprint names it, so a changed schedule is a new row.
 */
@Entity('schedules')
// One row per schedule, until plan step 11.6 makes it one per Workflow.
@Index('UQ_schedules_workflow_fingerprint', ['workflowName', 'fingerprint'], {
  unique: true,
})
@Index('IDX_schedules_next_run_at', ['nextRunAt'])
export class ScheduleState {
  @PrimaryGeneratedColumn({ type: 'integer' })
  id: number;

  /** The name of the Workflow it starts. */
  @Column({ name: 'workflow_name', type: 'text' })
  workflowName: string;

  /** The schedule's `scheduleFingerprint`: its cron and time zone. */
  @Column({ type: 'text' })
  fingerprint: string;

  /** The authoritative next occurrence, in UTC; null if none ever comes. */
  @Column({ name: 'next_run_at', type: 'datetime', nullable: true })
  nextRunAt: Date | null;

  @Column({ name: 'last_run_at', type: 'datetime', nullable: true })
  lastRunAt: Date | null;
}
