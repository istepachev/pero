import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, type EntityManager, LessThanOrEqual } from 'typeorm';
import { Agent } from '../persistence/entities/agent.entity.js';
import { Trigger } from '../persistence/entities/trigger.entity.js';
import { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { countOccurrences, nextOccurrence } from '../triggers/schedule.js';
import { WorkflowExecutor } from '../workflows/workflow-executor.js';

/** How often the scheduler looks for schedules that have come due. */
export const SCHEDULE_TICK_MS = 10_000;

/**
 * The most skipped times counted for one run. Far more than any schedule
 * misses in a realistic outage; it keeps a minute schedule down for months
 * from holding the transaction for seconds.
 */
export const MAX_SKIPPED_COUNT = 10_000;

/** What coming due did to a schedule Trigger, for the log. */
type Fired =
  | { kind: 'queued'; runId: number; workflow: string; skipped: number }
  | { kind: 'coalesced'; runId: number; workflow: string; skipped: number }
  | {
      kind: 'held';
      workflow: string;
      reason: 'workflow' | 'agent';
      agent: string;
    }
  | { kind: 'duplicate'; workflow: string; triggerKey: string };

/**
 * Turns schedules that have come due into pending Workflow Runs. The saved
 * `next_run_at` is the schedule, not this tick: each Trigger that has come
 * due gets one short transaction that creates its run and advances it, so a
 * time missed while Pero was down is found on the next tick after startup.
 */
@Injectable()
export class ScheduleTick
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('Scheduler');
  /** The tick under way, if any. */
  private current: Promise<void> | null = null;
  private stopping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly executor: WorkflowExecutor,
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
   * Queues a run for each schedule Trigger due by `now`. Missed times
   * coalesce into one run that records how many it stands for. Ticks may
   * overlap: each Trigger's transaction reads it afresh, and the trigger key
   * leaves one run per time however often it comes due.
   */
  async tick(now: Date = new Date()): Promise<void> {
    const due = await this.dataSource.getRepository(Trigger).find({
      select: { id: true },
      where: {
        kind: 'schedule',
        enabled: true,
        nextRunAt: LessThanOrEqual(now),
      },
      order: { nextRunAt: 'ASC', id: 'ASC' },
    });
    let queued = false;
    for (const { id } of due) {
      if (this.stopping) return;
      try {
        const fired = await inTransaction(this.dataSource, (manager) =>
          this.fireWithin(manager, id, now),
        );
        if (fired === null) continue;
        this.report(id, fired);
        queued ||= fired.kind === 'queued' || fired.kind === 'coalesced';
      } catch (error) {
        this.logger.error(
          `Could not start schedule Trigger ${id}: ${describe(error)}`,
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
   * Advances Trigger `id` past `now` and queues the run its due time
   * starts, unless it is no longer due. A Workflow or Agent that is
   * disabled gets no run, and the time passes; a run of this Trigger still
   * waiting to start takes the new times into its skipped count instead.
   */
  private async fireWithin(
    manager: EntityManager,
    id: number,
    now: Date,
  ): Promise<Fired | null> {
    const triggers = manager.getRepository(Trigger);
    const trigger = await triggers.findOne({
      where: { id },
      relations: { workflow: true },
    });
    if (
      trigger === null ||
      trigger.kind !== 'schedule' ||
      !trigger.enabled ||
      trigger.nextRunAt === null ||
      trigger.nextRunAt > now
    ) {
      return null;
    }
    const due = trigger.nextRunAt;
    const schedule = {
      cron: String(trigger.config.cron),
      // Every schedule has one; see `TriggersService.add`.
      timezone: trigger.timezone!,
    };
    const skipped = countOccurrences(schedule, due, now, MAX_SKIPPED_COUNT);
    const nextRunAt = nextOccurrence(schedule, now);
    // The foreign key guarantees the Workflow and its Agent.
    const workflow = trigger.workflow!;
    const agent = await manager
      .getRepository(Agent)
      .findOneByOrFail({ id: workflow.agentId });

    if (!workflow.enabled || !agent.enabled) {
      await triggers.update(id, { nextRunAt });
      return {
        kind: 'held',
        workflow: workflow.name,
        reason: workflow.enabled ? 'agent' : 'workflow',
        agent: agent.name,
      };
    }

    const runs = manager.getRepository(WorkflowRun);
    const waiting = await runs.findOne({
      where: { triggerId: id, status: 'pending' },
      order: { id: 'DESC' },
    });
    if (waiting !== null) {
      const total = Math.min(
        waiting.skippedCount + skipped + 1,
        MAX_SKIPPED_COUNT,
      );
      await runs.update(waiting.id, { skippedCount: total });
      await triggers.update(id, { nextRunAt });
      return {
        kind: 'coalesced',
        runId: waiting.id,
        workflow: workflow.name,
        skipped: total,
      };
    }

    // From the saved time, not `now`: every tick that reads this row
    // builds the same key, so the unique index allows one run per time.
    const triggerKey = `schedule:${id}:${due.toISOString()}`;
    const inserted = await runs
      .createQueryBuilder()
      .insert()
      .values({
        workflowId: workflow.id,
        triggerId: id,
        triggerKey,
        status: 'pending',
        attempt: 1,
        skippedCount: skipped,
      })
      .orIgnore()
      .execute();
    const runId = inserted.identifiers[0]?.id as number | undefined;
    await triggers.update(id, {
      nextRunAt,
      ...(runId === undefined ? {} : { lastRunAt: now }),
    });
    return runId === undefined
      ? { kind: 'duplicate', workflow: workflow.name, triggerKey }
      : { kind: 'queued', runId, workflow: workflow.name, skipped };
  }

  private report(id: number, fired: Fired): void {
    const skipped = (count: number) =>
      count === 0
        ? ''
        : ` (caught up ${count}${count >= MAX_SKIPPED_COUNT ? ' or more' : ''} missed ${count === 1 ? 'time' : 'times'})`;
    switch (fired.kind) {
      case 'queued':
        this.logger.log(
          `Run ${fired.runId} of Workflow ${fired.workflow} queued by schedule Trigger ${id}${skipped(fired.skipped)}`,
        );
        break;
      case 'coalesced':
        this.logger.log(
          `Schedule Trigger ${id} came due while run ${fired.runId} of Workflow ${fired.workflow} waited to start; it now stands for ${fired.skipped} more ${fired.skipped === 1 ? 'time' : 'times'}`,
        );
        break;
      case 'held':
        // A disabled Workflow is paused on purpose; a disabled Agent may not be.
        if (fired.reason === 'workflow') {
          this.logger.debug(
            `Schedule Trigger ${id} came due, but Workflow ${fired.workflow} is disabled; no run`,
          );
        } else {
          this.logger.warn(
            `Schedule Trigger ${id} of Workflow ${fired.workflow} came due, but Agent ${fired.agent} is disabled; no run`,
          );
        }
        break;
      case 'duplicate':
        this.logger.warn(
          `Schedule Trigger ${id} of Workflow ${fired.workflow} already has run ${fired.triggerKey}`,
        );
        break;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
