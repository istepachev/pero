import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager, FindOptionsWhere } from 'typeorm';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from '../common/errors.js';
import type {
  ControlResult,
  ParsedControlParams,
  RunDetails,
  RunView,
} from '../control/protocol.js';
import {
  NOTIFICATION_RELATIONS,
  notificationView,
} from '../notifications/notification-views.service.js';
import { Notification } from '../persistence/entities/notification.entity.js';
import { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import type { ResolvedWorkflow } from '../system-files/snapshot.js';
import {
  Definitions,
  requireWorkflow,
} from '../system/definitions.js';
import { SystemNotes } from '../system/system-notes.service.js';
import {
  historyReadSchema,
  historyWindowSchema,
} from './execution-snapshot.js';
import { finishRun } from './finish-run.js';
import { queueRetryWithin, retryKey } from './retry-run.js';
import { manualKey } from './run-keys.js';
import { runsWorkflowNameWithin } from './workflow-filter.js';
import { CANCELLED, WorkflowExecutor } from './workflow-executor.js';
import { missingWorkflow } from './workflow-views.service.js';

/**
 * Queues Workflow Runs started or retried by hand, cancels runs, and reads
 * them back.
 */
@Injectable()
export class WorkflowRuns {
  private readonly logger = new Logger('Workflows');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly executor: WorkflowExecutor,
    private readonly definitions: Definitions,
    private readonly notes: SystemNotes,
  ) {}

  /**
   * Queues a run of the Workflow named `name` and wakes the executor. Any
   * Workflow runs by hand, scheduled or not, and even while it is
   * disabled, which only stops it running by itself; its Agent must be
   * enabled. A run queued while another of the Workflow is running waits
   * for it.
   */
  async start(name: string): Promise<RunView> {
    const run = await inTransaction(this.dataSource, async (manager) => {
      const workflow = this.definitions.workflow(name);
      if (workflow === null) throw missingWorkflow(this.notes, name);
      this.requireRunnable(workflow);
      const runs = manager.getRepository(WorkflowRun);
      const { id } = await runs.save(
        runs.create({
          workflowName: workflow.name,
          // Each start by hand is its own occurrence.
          triggerKey: manualKey(randomUUID()),
          status: 'pending',
          attempt: 1,
        }),
      );
      return runView(await runs.findOneByOrFail({ id }));
    });
    this.logger.log(`Run ${run.id} of Workflow ${run.workflow} queued`);
    void this.executor.wake();
    return run;
  }

  /**
   * Cancels run `id`. A pending run is `cancelled` at once; a running one
   * has its Agent's turn aborted and is recorded `cancelled` when the turn
   * stops, so it is returned still `running`. `ConflictError` once it has
   * finished.
   */
  async cancel(id: number): Promise<RunView> {
    // Serialized with claims, so a pending run cannot start meanwhile.
    const status = await inTransaction(this.dataSource, async (manager) => {
      const runs = manager.getRepository(WorkflowRun);
      const run = await runs.findOneBy({ id });
      if (run === null) throw new NotFoundError(`No run with ID ${id}`);
      if (run.status === 'pending') {
        const workflow = this.definitions.workflow(run.workflowName);
        await finishRun(manager, id, workflow, {
          status: 'cancelled',
          errorText: CANCELLED,
        });
      } else if (run.status !== 'running') {
        throw new ConflictError(
          `Run ${id} has already finished (${run.status})`,
        );
      }
      return run.status;
    });
    if (status === 'running') {
      // False only if it finished since, which the view then shows.
      this.executor.cancel(id);
    }
    const run = await this.get(id);
    this.logger.log(
      status === 'pending'
        ? `Run ${id} of Workflow ${run.workflow} cancelled before it started`
        : `Cancelling run ${id} of Workflow ${run.workflow}`,
    );
    return run;
  }

  /**
   * Queues failed, interrupted, or cancelled run `id` again, as a new run
   * with the next attempt that reads the same history window, and wakes the
   * executor. The owner decides, so the Workflow's attempts do not limit
   * it, nor does its being disabled, but its Agent must be enabled. A run has one
   * retry: `ConflictError` names it once it exists, and refuses a run that
   * has not finished or that completed.
   */
  async retry(id: number): Promise<ControlResult<'runs.retry'>> {
    const result = await inTransaction(this.dataSource, async (manager) => {
      const runs = manager.getRepository(WorkflowRun);
      const run = await runs.findOneBy({ id });
      if (run === null) throw new NotFoundError(`No run with ID ${id}`);
      const name = run.workflowName;
      if (run.status === 'pending' || run.status === 'running') {
        throw new ConflictError(
          `Run ${id} has not finished (${run.status}); pero runs cancel ${id} cancels it`,
        );
      }
      if (run.status === 'completed') {
        throw new ConflictError(
          `Run ${id} completed; pero workflows run ${name} starts another`,
        );
      }
      const existing = await runs.findOneBy({
        workflowName: run.workflowName,
        triggerKey: retryKey(id),
      });
      if (existing !== null) {
        throw new ConflictError(
          `Run ${id} is already retried by run ${existing.id}; retry that one instead`,
        );
      }
      const workflow = requireWorkflow(this.definitions, name);
      this.requireRunnable(workflow);
      const retryId = await queueRetryWithin(manager, run);
      return {
        run: runView(await runs.findOneByOrFail({ id: retryId })),
        alsoReadBy: await alsoReadBy(manager, run),
      };
    });
    this.logger.log(
      `Run ${id} of Workflow ${result.run.workflow} retried by hand as run ${result.run.id}`,
    );
    void this.executor.wake();
    return result;
  }

  /** Refuses to queue a run of `workflow` unless its Channel note is enabled. */
  private requireRunnable(workflow: ResolvedWorkflow): void {
    const note = this.definitions.channelNote(workflow.note);
    if (!note.enabled) {
      throw new InvalidInputError(
        `Channel note ${note.name} is disabled; enable it first (enabled: true in ${note.file})`,
      );
    }
  }

  /** The latest runs that match `filter`, newest first. */
  list(filter: ParsedControlParams<'runs.list'>): Promise<RunView[]> {
    return inTransaction(this.dataSource, async (manager) => {
      const where: FindOptionsWhere<WorkflowRun> = {};
      if (filter.status !== undefined) where.status = filter.status;
      if (filter.workflow !== undefined) {
        where.workflowName = await runsWorkflowNameWithin(
          manager,
          this.definitions,
          filter.workflow,
        );
      }
      const runs = await manager.getRepository(WorkflowRun).find({
        where,
        order: { id: 'DESC' },
        take: filter.limit,
      });
      return runs.map(runView);
    });
  }

  /**
   * Run `id` with its retry, the history it read, and its Notifications;
   * `NotFoundError` if none.
   */
  get(id: number): Promise<RunDetails> {
    return inTransaction(this.dataSource, async (manager) => {
      const runs = manager.getRepository(WorkflowRun);
      const run = await runs.findOneBy({ id });
      if (run === null) throw new NotFoundError(`No run with ID ${id}`);
      const retry = await runs.findOneBy({
        workflowName: run.workflowName,
        triggerKey: retryKey(id),
      });
      const history = historyReadSchema.safeParse(run.executionConfig?.history);
      const notifications = await manager.getRepository(Notification).find({
        where: { workflowRunId: id },
        relations: NOTIFICATION_RELATIONS,
        order: { id: 'ASC' },
      });
      return {
        ...runView(run),
        retriedBy: retry?.id ?? null,
        history: history.success
          ? {
              channels: history.data.channels,
              messages: history.data.messages,
              count: history.data.count,
              dropped: history.data.dropped,
            }
          : null,
        notifications: notifications.map(notificationView),
      };
    });
  }
}

/**
 * The first run of `run`'s Workflow completed after it that read messages
 * its window holds too, which its retry reads again; null when none did.
 */
async function alsoReadBy(
  manager: EntityManager,
  run: WorkflowRun,
): Promise<number | null> {
  const window = historyWindowSchema.safeParse(run.executionConfig?.history);
  if (!window.success) return null;
  const later = await manager
    .getRepository(WorkflowRun)
    .createQueryBuilder('run')
    .select('run.id', 'id')
    .where('run.workflowName = :workflowName', {
      workflowName: run.workflowName,
    })
    .andWhere('run.id > :id', { id: run.id })
    .andWhere('run.status = :status', { status: 'completed' })
    .andWhere(`json_extract(run.executionConfig, '$.history.count') > 0`)
    .andWhere(
      `json_extract(run.executionConfig, '$.history.untilId') > :afterId`,
      { afterId: window.data.afterId ?? 0 },
    )
    .andWhere(
      `coalesce(json_extract(run.executionConfig, '$.history.afterId'), 0) < :untilId`,
      { untilId: window.data.untilId },
    )
    .orderBy('run.id', 'ASC')
    .getRawOne<{ id: number }>();
  return later === undefined ? null : Number(later.id);
}

/** A run as the CLI shows it. */
export function runView(run: WorkflowRun): RunView {
  const text = run.result?.text;
  return {
    id: run.id,
    workflow: run.workflowName,
    triggerKey: run.triggerKey,
    status: run.status,
    attempt: run.attempt,
    skippedCount: run.skippedCount,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    result: typeof text === 'string' ? text : null,
    skipped: run.result?.skipped === true,
    error: run.errorText,
  };
}
