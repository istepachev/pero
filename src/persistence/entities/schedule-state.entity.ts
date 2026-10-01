import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Where the schedule of a Workflow stands: when it next comes due, and
 * when it last started a run. The schedule itself is a definition; its
 * fingerprint tells whether the row is still the Workflow's schedule, so a
 * changed schedule replaces the row's times.
 */
@Entity('schedules')
// One row per Workflow, as a Workflow has one schedule.
@Index('UQ_schedules_workflow_name', ['workflowName'], { unique: true })
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
