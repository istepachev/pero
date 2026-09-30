import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, type EntityManager, Like } from 'typeorm';
import { Definitions } from '../definitions/definitions.js';
import { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import {
  countOccurrences,
  nextOccurrence,
  type Schedule,
  scheduleFingerprint,
} from '../triggers/schedule.js';
import { SCHEDULE_KEY_PATTERN, scheduleKey } from '../workflows/run-keys.js';
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
      /** A Workflow disabled on purpose, rather than a missing piece. */
      paused: boolean;
      /** What keeps it from running, such as `Agent coach is disabled`. */
      problem: string;
    }
  | { kind: 'duplicate'; triggerKey: string }
  /** Due at the same time as another schedule of its Workflow. */
  | { kind: 'shared'; runId: number }
  /** No longer defined: its state was dropped. */
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
 */
@Injectable()
export class ScheduleTick
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('Scheduler');
  /** The tick under way, if any. */
  private current: Promise<void> | null = null;
  private stopping = false;
  /** Schedules whose first time could not be computed, already logged. */
  private failing = new Set<string>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly executor: WorkflowExecutor,
    private readonly definitions: Definitions,
  ) {}

  /** Catches up at once, rather than a tick interval after startup. */
  onApplicationBootstrap(): Promise<void> {
    return this.poll();
  }

  /** Lets a tick under way finish before the database closes. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.current;
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

  /** Gives each defined schedule a row, and drops the rest. */
  private async reconcile(now: Date): Promise<void> {
    const defined: DefinedSchedule[] = (
      await this.definitions.workflows()
    ).flatMap((workflow) =>
      workflow.schedules.map((schedule) => ({
        workflow: workflow.name,
        schedule,
      })),
    );
    const reconciled = await inTransaction(this.dataSource, (manager) =>
      reconcileSchedulesWithin(manager, defined, now),
    );
    this.reportReconciled(reconciled);
  }

  /**
   * Advances schedule row `id` past `now` and queues the run its due time
   * starts, unless it is no longer due. A schedule no longer defined,
   * such as one of a Workflow that is gone, loses its row. One whose
   * Workflow is disabled, or whose Agent is disabled or gone, gets no run,
   * and the time passes; a scheduled run of its Workflow still waiting to
   * start takes the new times into its skipped count instead.
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
    const workflow = await this.definitions.workflow(name);
    const schedule =
      workflow?.schedules.find(
        (candidate) => scheduleFingerprint(candidate) === row.fingerprint,
      ) ?? null;
    if (workflow === null || schedule === null) {
      await dropScheduleWithin(manager, id);
      return { workflow: name, schedule, result: { kind: 'dropped' } };
    }
    const fired = (result: Fired) => ({ workflow: name, schedule, result });

    const skipped = countOccurrences(schedule, due, now, MAX_SKIPPED_COUNT);
    const nextRunAt = nextOccurrence(schedule, now);
    const agent = await this.definitions.agent(workflow.agent);
    if (!workflow.enabled || agent === null || !agent.enabled) {
      await advanceScheduleWithin(manager, id, { nextRunAt });
      return fired({
        kind: 'held',
        paused: !workflow.enabled,
        problem: !workflow.enabled
          ? `Workflow ${name} is disabled`
          : agent === null
            ? `Agent ${workflow.agent} no longer exists`
            : `Agent ${agent.name} is disabled`,
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
    // Another schedule of the Workflow may have come due at the same time.
    if (waiting?.triggerKey === triggerKey) {
      await advanceScheduleWithin(manager, id, { nextRunAt, lastRunAt: now });
      return fired({ kind: 'shared', runId: waiting.id });
    }
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
        triggerId: null,
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
        ? `A schedule of Workflow ${workflow}`
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
        // A disabled Workflow is paused on purpose; a disabled Agent may not be.
        if (fired.paused) {
          this.logger.debug(`${which} came due, but ${fired.problem}; no run`);
        } else {
          this.logger.warn(`${which} came due, but ${fired.problem}; no run`);
        }
        break;
      case 'duplicate':
        this.logger.warn(
          `${which} came due, but Workflow ${workflow} already has run ${fired.triggerKey}`,
        );
        break;
      case 'shared':
        this.logger.debug(
          `${which} came due with another of its schedules; run ${fired.runId} stands for both`,
        );
        break;
      case 'dropped':
        this.logger.log(
          `${which} is no longer defined; its saved times are dropped`,
        );
        break;
    }
  }

  /** Logs new and dropped schedules, and each failure once. */
  private reportReconciled({ added, dropped, failed }: Reconciled): void {
    for (const { workflow, schedule, nextRunAt } of added) {
      this.logger.log(
        `Workflow ${workflow} runs on the schedule ${describeSchedule(schedule)}, ${nextRunAt === null ? 'which never comes due' : `next at ${nextRunAt.toISOString()}`}`,
      );
    }
    for (const { workflow } of dropped) {
      this.logger.log(
        `A schedule of Workflow ${workflow} is no longer defined; its saved times are dropped`,
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
}

/** `schedule` for the log, such as `0 9 * * * (Europe/Berlin)`. */
function describeSchedule(schedule: Schedule): string {
  return `${schedule.cron} (${schedule.timezone})`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
