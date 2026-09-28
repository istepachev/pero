import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { findAgent } from '../agents/agents.service.js';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
  parseInput,
} from '../common/errors.js';
import { withoutUndefined } from '../common/without-undefined.js';
import {
  type WorkflowCreate,
  type WorkflowEdit,
  workflowCreateSchema,
  workflowEditSchema,
} from '../config/workflow-input.js';
import type { Agent } from '../persistence/entities/agent.entity.js';
import { Workflow } from '../persistence/entities/workflow.entity.js';
import { inTransaction } from '../persistence/transaction.js';

/**
 * Creates and edits Workflow definitions. A Workflow is never deleted, only
 * disabled, since its runs refer to it.
 */
@Injectable()
export class WorkflowsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  get(name: string): Promise<Workflow> {
    return findWorkflow(this.dataSource.manager, name);
  }

  /** Creates a Workflow for an existing, enabled Agent. */
  async create(input: WorkflowCreate): Promise<Workflow> {
    const fields = parseInput(workflowCreateSchema, input);
    return inTransaction(this.dataSource, async (manager) => {
      const workflows = manager.getRepository(Workflow);
      if (await workflows.existsBy({ name: fields.name })) {
        throw new ConflictError(
          `A Workflow named ${fields.name} already exists`,
        );
      }
      const agent = await enabledAgent(manager, fields.agent);
      const { id } = await workflows.save(
        workflows.create({
          name: fields.name,
          title: fields.title ?? null,
          agentId: agent.id,
          inputTemplate: fields.inputTemplate,
          ...(fields.maxAttempts === undefined
            ? {}
            : { maxAttempts: fields.maxAttempts }),
        }),
      );
      return workflows.findOneByOrFail({ id });
    });
  }

  /**
   * Changes a Workflow. A new Agent must be enabled; enabling a Workflow
   * whose Agent is disabled is allowed; it cannot run until the Agent is.
   */
  async edit(name: string, input: WorkflowEdit): Promise<Workflow> {
    const patch = parseInput(workflowEditSchema, input);
    return inTransaction(this.dataSource, async (manager) => {
      const workflows = manager.getRepository(Workflow);
      const workflow = await findWorkflow(manager, name);
      const agentId =
        patch.agent === undefined
          ? undefined
          : (await enabledAgent(manager, patch.agent)).id;
      const fields = withoutUndefined({
        title: patch.title,
        agentId,
        inputTemplate: patch.inputTemplate,
        maxAttempts: patch.maxAttempts,
        enabled: patch.enabled,
      });
      if (Object.keys(fields).length === 0) return workflow;
      await workflows.update(workflow.id, fields);
      return workflows.findOneByOrFail({ id: workflow.id });
    });
  }
}

/** The Workflow named `name`, in any case; `NotFoundError` otherwise. */
export async function findWorkflow(
  manager: EntityManager,
  name: string,
): Promise<Workflow> {
  const workflow = await manager
    .getRepository(Workflow)
    .findOneBy({ name: name.toLowerCase() });
  if (workflow === null) throw new NotFoundError(`No Workflow named ${name}`);
  return workflow;
}

/** The Agent named `name`, which must be enabled to take on a Workflow. */
async function enabledAgent(
  manager: EntityManager,
  name: string,
): Promise<Agent> {
  const agent = await findAgent(manager, name);
  if (!agent.enabled) {
    throw new InvalidInputError(
      `Agent ${agent.name} is disabled; enable it first with pero agents enable ${agent.name}`,
    );
  }
  return agent;
}
