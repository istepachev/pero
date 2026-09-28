import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AgentManager, TurnError } from '../agents/agent-manager.js';
import { AgentsService } from '../agents/agents.service.js';
import {
  SETTINGS_ID,
  Settings,
} from '../persistence/entities/settings.entity.js';
import {
  type RunStatus,
  WorkflowRun,
} from '../persistence/entities/workflow-run.entity.js';
import { Workflow } from '../persistence/entities/workflow.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import {
  type ExecutionSnapshot,
  executionSnapshot,
} from './execution-snapshot.js';

/** A run the executor has claimed and marked `running`. */
interface ClaimedRun {
  runId: number;
  workflowId: number;
  workflow: string;
  snapshot: ExecutionSnapshot;
}

/** How a run ended, as recorded. */
type Outcome =
  | { status: 'completed'; text: string; providerSessionId: string | null }
  | { status: Extract<RunStatus, 'failed' | 'interrupted'>; error: string };

/**
 * The bounded in-process executor for Workflow Runs. SQLite holds the work:
 * the executor claims the oldest `pending` run while fewer than the
 * `max-concurrent-runs` setting are running, at most one per Workflow, and
 * runs it through `AgentManager` in a context of its own, away from every
 * Channel's Session. It never holds a transaction while an Agent works.
 */
@Injectable()
export class WorkflowExecutor
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('Workflows');
  /** Each running run until its outcome is recorded, by run ID. */
  private readonly active = new Map<number, Promise<void>>();
  /** Workflows with a run in `active`. */
  private readonly busyWorkflows = new Set<number>();
  /** The latest pass over pending runs; passes run one at a time. */
  private pass: Promise<void> = Promise.resolve();
  /** A pass that has not begun yet, which later wakes share. */
  private queued: Promise<void> | null = null;
  private stopping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly agents: AgentsService,
    private readonly agentManager: AgentManager,
  ) {}

  /** Picks up runs left `pending` when Pero last stopped. */
  onApplicationBootstrap(): Promise<void> {
    return this.wake();
  }

  /**
   * Starts pending runs while slots are free. Settles once they have
   * started, not finished.
   */
  wake(): Promise<void> {
    if (this.queued === null) {
      const next = this.pass
        .then(() => {
          this.queued = null;
          return this.fill();
        })
        .catch((error: unknown) => {
          this.logger.error(
            `Could not start pending Workflow Runs: ${describe(error)}`,
          );
        });
      this.queued = next;
      this.pass = next;
    }
    return this.queued;
  }

  /** How many runs are executing now. */
  get running(): number {
    return this.active.size;
  }

  /** Settles once no run is executing and no pass is under way. */
  async idle(): Promise<void> {
    for (;;) {
      const pass = this.pass;
      await Promise.all([pass, ...this.active.values()]);
      if (this.pass === pass && this.active.size === 0) return;
    }
  }

  /**
   * Stops claiming runs, then lets running ones finish until the Agent
   * shutdown timeout aborts them, and records how each ended.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.pass;
    await this.agentManager.drain();
    await Promise.all(this.active.values());
  }

  private async fill(): Promise<void> {
    while (!this.stopping) {
      const claimed = await inTransaction(this.dataSource, (manager) =>
        this.claimWithin(manager),
      );
      if (claimed === null) return;
      this.start(claimed);
    }
  }

  /**
   * Claims the oldest pending run of a Workflow with none running, if a
   * slot is free, and snapshots what it executes with. A run whose Workflow
   * or Agent was disabled since it was queued fails instead.
   */
  private async claimWithin(
    manager: EntityManager,
  ): Promise<ClaimedRun | null> {
    // Read on every claim, so a changed limit applies without a restart.
    const { maxConcurrentRuns } = await manager
      .getRepository(Settings)
      .findOneByOrFail({ id: SETTINGS_ID });
    if (this.stopping || this.active.size >= maxConcurrentRuns) return null;
    const runs = manager.getRepository(WorkflowRun);
    for (;;) {
      const query = runs
        .createQueryBuilder('run')
        .where('run.status = :status', { status: 'pending' });
      // In memory, not `running` rows: one left by a crash runs no longer.
      if (this.busyWorkflows.size > 0) {
        query.andWhere('run.workflowId NOT IN (:...busy)', {
          busy: [...this.busyWorkflows],
        });
      }
      const run = await query
        .orderBy('run.createdAt', 'ASC')
        .addOrderBy('run.id', 'ASC')
        .getOne();
      if (run === null) return null;
      const workflow = await manager
        .getRepository(Workflow)
        .findOneByOrFail({ id: run.workflowId });
      const agent = await this.agents.resolveWithin(manager, workflow.agentId);
      const refused = !workflow.enabled
        ? `Workflow ${workflow.name} was disabled before the run started`
        : !agent.enabled
          ? `Agent ${agent.name} was disabled before the run started`
          : null;
      if (refused !== null) {
        await runs.update(run.id, {
          status: 'failed',
          finishedAt: new Date(),
          errorText: refused,
        });
        this.logger.warn(
          `Run ${run.id} of Workflow ${workflow.name}: ${refused}`,
        );
        continue;
      }
      const snapshot = executionSnapshot(agent, workflow.inputTemplate);
      await runs.update(run.id, {
        status: 'running',
        startedAt: new Date(),
        executionConfig: snapshot,
      });
      return {
        runId: run.id,
        workflowId: workflow.id,
        workflow: workflow.name,
        snapshot,
      };
    }
  }

  private start(claimed: ClaimedRun): void {
    this.busyWorkflows.add(claimed.workflowId);
    const done = this.execute(claimed)
      .catch((error: unknown) => {
        this.logger.error(
          `Could not record the outcome of run ${claimed.runId}: ${describe(error)}`,
        );
      })
      .finally(() => {
        this.active.delete(claimed.runId);
        this.busyWorkflows.delete(claimed.workflowId);
        void this.wake();
      });
    this.active.set(claimed.runId, done);
  }

  private async execute(claimed: ClaimedRun): Promise<void> {
    const { runId, workflow, snapshot } = claimed;
    const label = `Workflow ${workflow}, run ${runId}`;
    this.logger.log(`Run ${runId} of Workflow ${workflow} started`);
    let outcome: Outcome;
    try {
      const { text, providerSessionId } = await this.agentManager.runIsolated({
        agent: {
          id: snapshot.agentId,
          name: snapshot.agentName,
          provider: snapshot.provider,
          providerOptions: snapshot.providerOptions,
          workingDirectory: snapshot.workingDirectory,
          instructions: snapshot.instructions,
          toolPolicy: snapshot.toolPolicy,
          codexSkipGitRepoCheck: snapshot.codexSkipGitRepoCheck,
        },
        input: snapshot.input,
        label,
      });
      outcome = { status: 'completed', text, providerSessionId };
    } catch (error) {
      if (!(error instanceof TurnError)) {
        this.logger.error(`${label} failed: ${describe(error)}`);
      }
      outcome =
        error instanceof TurnError
          ? {
              status: error.interrupted ? 'interrupted' : 'failed',
              error: error.interrupted
                ? 'Pero stopped before the run finished'
                : error.message,
            }
          : { status: 'failed', error: 'Pero failed to run it; see pero logs' };
    }
    await inTransaction(this.dataSource, (manager) =>
      manager.getRepository(WorkflowRun).update(runId, {
        status: outcome.status,
        finishedAt: new Date(),
        ...(outcome.status === 'completed'
          ? {
              result: {
                text: outcome.text,
                ...(outcome.providerSessionId === null
                  ? {}
                  : { providerSessionId: outcome.providerSessionId }),
              },
            }
          : { errorText: outcome.error }),
      }),
    );
    this.logger.log(`Run ${runId} of Workflow ${workflow} ${outcome.status}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
