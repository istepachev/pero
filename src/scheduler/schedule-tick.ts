import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, type EntityManager, Like } from 'typeorm';
import { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import type { ResolvedWorkflow } from '../system-files/snapshot.js';
import { Definitions } from '../system/definitions.js';
import {
  countOccurrences,
  nextOccurrence,
  type Schedule,
  scheduleFingerprint,
} from './schedule.js';
import { SCHEDULE_KEY_PATTERN, scheduleKey } from '../workflows/run-keys.js';
import {
  type CancelledRun,
  cancelWaitingRunsWithin,
} from '../workflows/waiting-runs.js';
import { WorkflowExecutor } from '../workflows/workflow-executor.js';
import {
  advanceScheduleWithin,
  type DefinedSchedule,
  dropScheduleWithin,
  dueSchedules,
  dueScheduleWithin,
  type Reconciled,
  reconcileSchedulesWithin,
} from './schedule-state.js';

/** How often the scheduler looks for schedules that have come due. */
export const SCHEDULE_TICK_MS = 10_000;

/**
 * The most skipped times counted for one run. Far more than any schedule
 * misses in a realistic outage; it keeps a minute schedule down for months
 * from holding the transaction for seconds.
 */
export const MAX_SKIPPED_COUNT = 10_000;

/** What coming due did to a schedule, for the log. */
type Fired =
  | { kind: 'queued'; runId: number; skipped: number }
  | { kind: 'coalesced'; runId: number; skipped: number }
  | {
      kind: 'held';
      /** What keeps it from running, such as `Channel note coach is disabled`. */
      problem: string;
    }
  | { kind: 'duplicate'; triggerKey: string }
  /** No longer defined, or its Workflow disabled: its state was dropped. */
  | { kind: 'dropped' };

/** A schedule that came due, and what that did. */
interface FiredSchedule {
  workflow: string;
  /** Null when it is no longer defined. */
  schedule: Schedule | null;
  result: Fired;
}

/**
 * Turns schedules that have come due into pending Workflow Runs. The
 * schedules come from `Definitions`; where each stands is in `schedules`,
 * whose saved `next_run_at` is the schedule, not this tick. Each tick first
 * brings those rows in line with the definitions, then gives each row that
 * has come due one short transaction that creates its run and advances it,
 * so a time missed while Pero was down is found on the next tick after
 * startup.
 *
 * The rows are also brought in line at startup, before the executor picks
 * up waiting runs, and each time the definitions change, so an edited note
 * applies without waiting for a tick.
 */
@Injectable()
export class ScheduleTick
  implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('Scheduler');
  /** The tick under way, if any. */
  private current: Promise<void> | null = null;
  private stopping = false;
  /** Schedules whose first time could not be computed, already logged. */
  private failing = new Set<string>();
  /** The reconciling the latest change of the definitions started. */
  private reconciling: Promise<void> = Promise.resolve();
  private stopListening: (() => void) | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly executor: WorkflowExecutor,
    private readonly definitions: Definitions,
  ) {}

  /**
   * Brings the saved schedules in line with the definitions, cancelling
   * the waiting runs of Workflows that are gone or disabled. The
   * executor's `onModuleInit` settles first, and its
   * `onApplicationBootstrap` after, so it starts only runs that remain.
   * From then on, each change of the definitions does the same.
   */
  async onModuleInit(): Promise<void> {
    this.stopListening = this.definitions.onChange(() =>
      this.definitionsChanged(),
    );
    await this.reconcileLogged();
  }

  /** Catches up at once, rather than a tick interval after startup. */
  onApplicationBootstrap(): Promise<void> {
    return this.poll();
  }

  /** Lets a tick under way finish before the database closes. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.stopListening?.();
    await this.current;
    await this.reconciling;
  }

  @Interval('schedule-tick', SCHEDULE_TICK_MS)
  onInterval(): void {
    void this.poll();
  }

  /**
   * Brings the saved schedules in line with the definitions, then queues a
   * run for each schedule due by `now`. A new or changed schedule starts
   * from `now`, so it catches nothing up; a removed one loses its state.
   * Missed times coalesce into one run that records how many it stands
   * for. Ticks may overlap: each schedule's transaction reads it afresh,
   * and the trigger key leaves one run per time however often it comes due.
   */
  async tick(now: Date = new Date()): Promise<void> {
    await this.reconciling;
    await this.reconcile(now);
    const due = await dueSchedules(this.dataSource.manager, now);
    let queued = false;
    for (const { id, workflowName } of due) {
      if (this.stopping) return;
      try {
        const fired = await inTransaction(this.dataSource, (manager) =>
          this.fireWithin(manager, id, now),
        );
        if (fired === null) continue;
        this.report(fired.workflow, fired.schedule, fired.result);
        queued ||=
          fired.result.kind === 'queued' || fired.result.kind === 'coalesced';
      } catch (error) {
        this.logger.error(
          `Could not start a schedule of Workflow ${workflowName}: ${describe(error)}`,
        );
      }
    }
    if (queued) void this.executor.wake();
  }

  /** One tick at a time, skipped while stopping; never throws. */
  private poll(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.current ??= this.tick()
      .catch((error: unknown) => {
        this.logger.error(
          `Could not look for due schedules: ${describe(error)}`,
        );
      })
      .finally(() => {
        this.current = null;
      });
    return this.current;
  }

  /**
   * Settles once the definitions' latest change has been applied to the
   * saved schedules and waiting runs.
   */
  reconciled(): Promise<void> {
    return this.reconciling;
  }

  /** Reconciles after any reconciling under way, unless stopping. */
  private definitionsChanged(): void {
    if (this.stopping) return;
    this.reconciling = this.reconciling.then(() => this.reconcileLogged());
  }

  /** Reconciles as of now; never throws. */
  private async reconcileLogged(): Promise<void> {
    try {
      await this.reconcile(new Date());
    } catch (error) {
      this.logger.error(
        `Could not bring the schedules in line with the Workflow notes: ${describe(error)}`,
      );
    }
  }

  /**
   * Gives the schedule of each enabled Workflow a row, first due after
   * `now`, and drops the rest; cancels the runs waiting to start of
   * Workflows that are gone, and those their schedule queued of Workflows
   * that are disabled. The definitions are read in the transaction, so a
   * run queued meanwhile is judged by definitions at least as new.
   */
  private async reconcile(now: Date): Promise<void> {
    const { reconciled, cancelled, disabled } = await inTransaction(
      this.dataSource,
      async (manager) => {
        const workflows = this.definitions.workflows();
        const defined: DefinedSchedule[] = workflows.flatMap(
          ({ name, schedule, enabled }) =>
            enabled && schedule !== null ? [{ workflow: name, schedule }] : [],
        );
        return {
          reconciled: await reconcileSchedulesWithin(manager, defined, now),
          cancelled: await cancelWaitingRunsWithin(manager, workflows),
          disabled: disabledNames(workflows),
        };
      },
    );
    this.reportReconciled(reconciled, disabled);
    this.reportCancelled(cancelled);
  }

  /**
   * Advances schedule row `id` past `now` and queues the run its due time
   * starts, unless it is no longer due. A schedule no longer defined,
   * such as one of a Workflow that is gone or disabled, loses its row. One
   * whose Channel note is disabled gets no run, and the time passes; a
   * scheduled run of its Workflow still waiting to start takes the new
   * times into its skipped count instead.
   */
  private async fireWithin(
    manager: EntityManager,
    id: number,
    now: Date,
  ): Promise<FiredSchedule | null> {
    const row = await dueScheduleWithin(manager, id, now);
    if (row === null) return null;
    const { due } = row;
    const name = row.workflowName;
    const workflow = this.definitions.workflow(name);
    const defined = workflow?.schedule ?? null;
    // A row of a schedule since changed is not the Workflow's any more.
    const schedule =
      defined !== null && scheduleFingerprint(defined) === row.fingerprint
        ? defined
        : null;
    // Reconciling drops these first; a change can land in between.
    if (workflow === null || schedule === null || !workflow.enabled) {
      await dropScheduleWithin(manager, id);
      return { workflow: name, schedule, result: { kind: 'dropped' } };
    }
    const fired = (result: Fired) => ({ workflow: name, schedule, result });

    const skipped = countOccurrences(schedule, due, now, MAX_SKIPPED_COUNT);
    const nextRunAt = nextOccurrence(schedule, now);
    const note = this.definitions.channelNote(workflow.note);
    if (!note.enabled) {
      await advanceScheduleWithin(manager, id, { nextRunAt });
      return fired({
        kind: 'held',
        problem: `Channel note ${note.name} is disabled`,
      });
    }

    // From the saved time, not `now`: every tick that reads this row
    // builds the same key, so the unique index allows one run per time.
    const triggerKey = scheduleKey(name, due);
    const runs = manager.getRepository(WorkflowRun);
    const waiting = await runs.findOne({
      where: {
        workflowName: name,
        triggerKey: Like(SCHEDULE_KEY_PATTERN),
        status: 'pending',
      },
      order: { id: 'DESC' },
    });
    if (waiting !== null) {
      const total = Math.min(
        waiting.skippedCount + skipped + 1,
        MAX_SKIPPED_COUNT,
      );
      await runs.update(waiting.id, { skippedCount: total });
      await advanceScheduleWithin(manager, id, { nextRunAt });
      return fired({ kind: 'coalesced', runId: waiting.id, skipped: total });
    }

    const inserted = await runs
      .createQueryBuilder()
      .insert()
      .values({
        workflowName: name,
        triggerKey,
        status: 'pending',
        attempt: 1,
        skippedCount: skipped,
      })
      .orIgnore()
      .execute();
    const runId = inserted.identifiers[0]?.id as number | undefined;
    await advanceScheduleWithin(manager, id, {
      nextRunAt,
      ...(runId === undefined ? {} : { lastRunAt: now }),
    });
    return fired(
      runId === undefined
        ? { kind: 'duplicate', triggerKey }
        : { kind: 'queued', runId, skipped },
    );
  }

  private report(
    workflow: string,
    schedule: Schedule | null,
    fired: Fired,
  ): void {
    const which =
      schedule === null
        ? `The schedule of Workflow ${workflow}`
        : `The schedule ${describeSchedule(schedule)} of Workflow ${workflow}`;
    const skipped = (count: number) =>
      count === 0
        ? ''
        : ` (caught up ${count}${count >= MAX_SKIPPED_COUNT ? ' or more' : ''} missed ${count === 1 ? 'time' : 'times'})`;
    switch (fired.kind) {
      case 'queued':
        this.logger.log(
          `Run ${fired.runId} of Workflow ${workflow} queued by its schedule ${describeSchedule(schedule!)}${skipped(fired.skipped)}`,
        );
        break;
      case 'coalesced':
        this.logger.log(
          `${which} came due while run ${fired.runId} waited to start; it now stands for ${fired.skipped} more ${fired.skipped === 1 ? 'time' : 'times'}`,
        );
        break;
      case 'held':
        this.logger.warn(`${which} came due, but ${fired.problem}; no run`);
        break;
      case 'duplicate':
        this.logger.warn(
          `${which} came due, but Workflow ${workflow} already has run ${fired.triggerKey}`,
        );
        break;
      case 'dropped':
        this.logger.log(
          `${which} is no longer defined, or its Workflow is disabled; its saved times are dropped`,
        );
        break;
    }
  }

  /**
   * Logs new and dropped schedules, and each failure once. `disabled`
   * names the Workflows that are disabled, lower case.
   */
  private reportReconciled(
    { added, dropped, failed }: Reconciled,
    disabled: ReadonlySet<string>,
  ): void {
    for (const { workflow, schedule, nextRunAt } of added) {
      this.logger.log(
        `Workflow ${workflow} runs on the schedule ${describeSchedule(schedule)}, ${nextRunAt === null ? 'which never comes due' : `next at ${nextRunAt.toISOString()}`}`,
      );
    }
    for (const { workflow } of dropped) {
      this.logger.log(
        disabled.has(workflow.toLowerCase())
          ? `Workflow ${workflow} is disabled; the saved times of its schedule are dropped`
          : `The schedule Workflow ${workflow} had is no longer defined; its saved times are dropped`,
      );
    }
    const failing = new Set<string>();
    for (const { workflow, schedule, error } of failed) {
      const key = `${workflow}\n${scheduleFingerprint(schedule)}`;
      failing.add(key);
      if (this.failing.has(key)) continue;
      this.logger.error(
        `Could not schedule Workflow ${workflow} on ${describeSchedule(schedule)}: ${describe(error)}`,
      );
    }
    this.failing = failing;
  }

  private reportCancelled(cancelled: readonly CancelledRun[]): void {
    for (const { runId, workflow, reason } of cancelled) {
      this.logger.log(
        `Run ${runId} of Workflow ${workflow} cancelled before it started: ${reason}`,
      );
    }
  }
}

/** The names of the disabled Workflows among `workflows`, lower case. */
function disabledNames(workflows: readonly ResolvedWorkflow[]): Set<string> {
  return new Set(
    workflows
      .filter((workflow) => !workflow.enabled)
      .map((workflow) => workflow.name.toLowerCase()),
  );
}

/** `schedule` for the log, such as `0 9 * * * (Europe/Berlin)`. */
function describeSchedule(schedule: Schedule): string {
  return `${schedule.cron} (${schedule.timezone})`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
