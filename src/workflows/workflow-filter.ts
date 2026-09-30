import type { EntityManager } from 'typeorm';
import { NotFoundError } from '../common/errors.js';
import type { Definitions } from '../definitions/definitions.js';
import { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';

/**
 * The name runs of the Workflow named `name`, in any case, are recorded
 * under, inside the caller's transaction. Known while the Workflow is
 * defined or any run has it, so the runs of one that is gone still list;
 * `NotFoundError` otherwise.
 */
export async function runsWorkflowNameWithin(
  manager: EntityManager,
  definitions: Definitions,
  name: string,
): Promise<string> {
  const workflowName = name.toLowerCase();
  if (
    (await definitions.workflow(workflowName)) === null &&
    !(await manager.getRepository(WorkflowRun).existsBy({ workflowName }))
  ) {
    throw new NotFoundError(`No Workflow named ${name}`);
  }
  return workflowName;
}
