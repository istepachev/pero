import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { createRunNotifications } from '../notifications/run-notifications.js';
import {
  type RunStatus,
  WorkflowRun,
} from '../persistence/entities/workflow-run.entity.js';
import type { ExecutionSnapshot } from './execution-snapshot.js';
import type { ResolvedWorkflow } from '../system-files/snapshot.js';

const logger = new Logger('Notifications');

/** How a run can end. */
export type FinishedStatus = Exclude<RunStatus, 'pending' | 'running'>;

/** What finishing a run records; `finishedAt` defaults to now. */
export interface RunFinish {
  status: FinishedStatus;
  startedAt?: Date;
  finishedAt?: Date;
  executionConfig?: ExecutionSnapshot;
  /** The answer. */
  result?: { text: string; providerSessionId?: string };
  errorText?: string;
}

/**
 * Records run `runId`'s final status, and creates its Notifications in the
 * same transaction, so they commit together. Every run ends through here.
 * Creating Notifications runs in a savepoint of its own: should it fail,
 * the run is recorded without them, so a Notification never keeps a run
 * `running`. They go to the Channels `workflow`, the run's Workflow as it
 * is defined now, notifies; none when it is gone. `retried` says an
 * interrupted run has a retry queued.
 */
export async function finishRun(
  manager: EntityManager,
  runId: number,
  workflow: ResolvedWorkflow | null,
  fields: RunFinish,
  { retried = false }: { retried?: boolean } = {},
): Promise<void> {
  const runs = manager.getRepository(WorkflowRun);
  await runs.update(runId, { finishedAt: new Date(), ...fields });
  if (workflow === null) return;
  const run = await runs.findOneByOrFail({ id: runId });
  try {
    // A nested transaction is a savepoint on SQLite.
    await manager.transaction((inner) =>
      createRunNotifications(inner, run, workflow, retried),
    );
  } catch (error) {
    logger.error(
      `Could not create the Notifications of run ${runId}; it is recorded ${fields.status} without them: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
