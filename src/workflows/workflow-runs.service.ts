import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from '../common/errors.js';
import type { RunView } from '../control/protocol.js';
import { Agent } from '../persistence/entities/agent.entity.js';
import { Trigger } from '../persistence/entities/trigger.entity.js';
import { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import { Workflow } from '../persistence/entities/workflow.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { CANCELLED, WorkflowExecutor } from './workflow-executor.js';
import { findWorkflow } from './workflows.service.js';

/** Queues Workflow Runs started by hand, cancels runs, and reads them back. */
@Injectable()
export class WorkflowRuns {
  private readonly logger = new Logger('Workflows');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly executor: WorkflowExecutor,
  ) {}

  /**
   * Queues a run of the Workflow named `name` through its manual Trigger
   * and wakes the executor. The Workflow, its Agent, and the Trigger must
   * be enabled. A run queued while another of the Workflow is running
   * waits for it.
   */
  async start(name: string): Promise<RunView> {
    const run = await inTransaction(this.dataSource, async (manager) => {
      const workflow = await findWorkflow(manager, name);
      if (!workflow.enabled) {
        throw new InvalidInputError(
          `Workflow ${workflow.name} is disabled; enable it first with pero workflows enable ${workflow.name}`,
        );
      }
      const agent = await manager
        .getRepository(Agent)
        .findOneByOrFail({ id: workflow.agentId });
      if (!agent.enabled) {
        throw new InvalidInputError(
          `Agent ${agent.name} is disabled; enable it first with pero agents enable ${agent.name}`,
        );
      }
      const triggers = manager.getRepository(Trigger);
      const trigger = await triggers.findOneBy({
        workflowId: workflow.id,
        kind: 'manual',
      });
      if (trigger === null) {
        throw new InvalidInputError(
          `Workflow ${workflow.name} has no manual Trigger; add one with pero triggers add ${workflow.name} --manual`,
        );
      }
      if (!trigger.enabled) {
        throw new InvalidInputError(
          `The manual Trigger of Workflow ${workflow.name} is disabled; enable it with pero triggers enable ${trigger.id}`,
        );
      }
      const runs = manager.getRepository(WorkflowRun);
      const { id } = await runs.save(
        runs.create({
          workflowId: workflow.id,
          triggerId: trigger.id,
          // Each start by hand is its own occurrence.
          triggerKey: `manual:${randomUUID()}`,
          status: 'pending',
          attempt: 1,
        }),
      );
      await triggers.update(trigger.id, { lastRunAt: new Date() });
      return runView(await runs.findOneByOrFail({ id }), workflow);
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
        await runs.update(id, {
          status: 'cancelled',
          finishedAt: new Date(),
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

  /** Run `id`; `NotFoundError` if none. */
  async get(id: number): Promise<RunView> {
    const run = await this.dataSource.getRepository(WorkflowRun).findOne({
      where: { id },
      relations: { workflow: true },
    });
    if (run === null) throw new NotFoundError(`No run with ID ${id}`);
    // The foreign key guarantees the Workflow.
    return runView(run, run.workflow!);
  }
}

/** A run as the CLI shows it. */
export function runView(
  run: WorkflowRun,
  workflow: Pick<Workflow, 'name'>,
): RunView {
  const text = run.result?.text;
  return {
    id: run.id,
    workflow: workflow.name,
    triggerId: run.triggerId,
    triggerKey: run.triggerKey,
    status: run.status,
    attempt: run.attempt,
    skippedCount: run.skippedCount,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    result: typeof text === 'string' ? text : null,
    error: run.errorText,
  };
}
