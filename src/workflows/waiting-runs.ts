import type { EntityManager } from 'typeorm';
import { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import { finishRun } from './finish-run.js';
import { isScheduled } from './run-keys.js';
import type { ResolvedWorkflow } from '../settings-files/snapshot.js';

/** A run waiting to start that was cancelled, and why. */
export interface CancelledRun {
  runId: number;
  workflow: string;
  /** Such as `Workflow brief no longer exists`. */
  reason: string;
}

/**
 * Cancels the runs waiting to start that `workflows`, every Workflow
 * defined now, no longer allow: each run of a Workflow that is gone, and
 * each run a schedule queued of one that is disabled. A disabled Workflow
 * still runs by hand, so its other runs wait on, and a running run
 * finishes. Read `workflows` in the same transaction, so a run queued
 * after them is not taken for one of a Workflow that is gone.
 */
export async function cancelWaitingRunsWithin(
  manager: EntityManager,
  workflows: readonly ResolvedWorkflow[],
): Promise<CancelledRun[]> {
  const defined = new Map(
    workflows.map((workflow) => [workflow.name.toLowerCase(), workflow]),
  );
  const waiting = await manager.getRepository(WorkflowRun).find({
    select: { id: true, workflowName: true, triggerKey: true },
    where: { status: 'pending' },
    order: { id: 'ASC' },
  });
  const cancelled: CancelledRun[] = [];
  for (const run of waiting) {
    const name = run.workflowName;
    const workflow = defined.get(name.toLowerCase()) ?? null;
    let reason: string;
    if (workflow === null) {
      reason = `Workflow ${name} no longer exists`;
    } else if (!workflow.enabled && isScheduled(run.triggerKey)) {
      reason = `Workflow ${name} is disabled`;
    } else {
      continue;
    }
    await finishRun(manager, run.id, workflow, {
      status: 'cancelled',
      errorText: `Cancelled before it started: ${reason}`,
    });
    cancelled.push({ runId: run.id, workflow: name, reason });
  }
  return cancelled;
}
