import type { EntityManager } from 'typeorm';
import { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import { historyWindowSchema } from './execution-snapshot.js';

/** The trigger key of the retry of run `runId`: a run has at most one. */
export function retryKey(runId: number): string {
  return `retry:${runId}`;
}

/**
 * Queues the retry of `run` inside the caller's transaction: a new
 * `pending` run with the next attempt, which reads the same history window
 * and is claimed ahead of the Workflow's other pending runs. Queuing it
 * again returns the retry already there. Resolves to the retry's ID.
 */
export async function queueRetryWithin(
  manager: EntityManager,
  run: Pick<
    WorkflowRun,
    'id' | 'workflowId' | 'triggerId' | 'attempt' | 'executionConfig'
  >,
): Promise<number> {
  const runs = manager.getRepository(WorkflowRun);
  const triggerKey = retryKey(run.id);
  const window = historyWindowSchema.safeParse(run.executionConfig?.history);
  await runs
    .createQueryBuilder()
    .insert()
    .values({
      workflowId: run.workflowId,
      triggerId: run.triggerId,
      triggerKey,
      status: 'pending',
      attempt: run.attempt + 1,
      // Taken up when the retry is claimed.
      executionConfig: window.success ? { history: window.data } : null,
    })
    .orIgnore()
    .execute();
  // Found rather than taken from the insert, which an earlier retry may
  // have made a no-op.
  return (
    await runs.findOneByOrFail({ workflowId: run.workflowId, triggerKey })
  ).id;
}
