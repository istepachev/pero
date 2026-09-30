import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, type EntityManager, In } from 'typeorm';
import { findAgent } from '../agents/agents.service.js';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
  parseInput,
} from '../common/errors.js';
import { withoutUndefined } from '../common/without-undefined.js';
import {
  patchHistory,
  type WorkflowCreate,
  type WorkflowEdit,
  type WorkflowHistory,
  workflowCreateSchema,
  workflowEditSchema,
} from '../config/workflow-input.js';
import { SqliteDefinitions } from '../definitions/sqlite-definitions.js';
import type { Agent } from '../persistence/entities/agent.entity.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { WorkflowNotificationTarget } from '../persistence/entities/workflow-notification-target.entity.js';
import { Workflow } from '../persistence/entities/workflow.entity.js';
import { inTransaction } from '../persistence/transaction.js';

/**
 * Creates and edits Workflow definitions. A Workflow is never deleted, only
 * disabled, since its runs refer to it. Runtime code reads them through
 * `Definitions`; the reads here serve the CLI's edits and tests.
 */
@Injectable()
export class WorkflowsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly definitions: SqliteDefinitions,
  ) {}

  get(name: string): Promise<Workflow> {
    return findWorkflow(this.dataSource.manager, name);
  }

  /** Creates a Workflow for an existing, enabled Agent. */
  async create(input: WorkflowCreate): Promise<Workflow> {
    const fields = parseInput(workflowCreateSchema, input);
    return this.committing(async (manager) => {
      const workflows = manager.getRepository(Workflow);
      if (await workflows.existsBy({ name: fields.name })) {
        throw new ConflictError(
          `A Workflow named ${fields.name} already exists`,
        );
      }
      const agent = await enabledAgent(manager, fields.agent);
      const history =
        fields.history === undefined
          ? null
          : await existingChannels(manager, patchHistory(null, fields.history));
      const { id } = await workflows.save(
        workflows.create({
          name: fields.name,
          title: fields.title ?? null,
          agentId: agent.id,
          inputTemplate: fields.inputTemplate,
          history,
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
    return this.committing(async (manager) => {
      const workflows = manager.getRepository(Workflow);
      const workflow = await findWorkflow(manager, name);
      const agentId =
        patch.agent === undefined
          ? undefined
          : (await enabledAgent(manager, patch.agent)).id;
      const history =
        patch.history === undefined || patch.history === null
          ? patch.history
          : await existingChannels(
              manager,
              patchHistory(workflow.history, patch.history),
            );
      const fields = withoutUndefined({
        title: patch.title,
        agentId,
        inputTemplate: patch.inputTemplate,
        maxAttempts: patch.maxAttempts,
        enabled: patch.enabled,
        history,
      });
      if (Object.keys(fields).length === 0) return workflow;
      await workflows.update(workflow.id, fields);
      return workflows.findOneByOrFail({ id: workflow.id });
    });
  }

  /**
   * Makes the Workflow named `name` notify Channel `channelId` of each run
   * that finishes from now on. `changed` is false when it already did. A
   * disabled Workflow or Channel may be a target.
   */
  notify(name: string, channelId: number): Promise<TargetChange> {
    return this.committing(async (manager) => {
      const workflow = await findWorkflow(manager, name);
      const channel = await existingChannel(manager, channelId);
      const targets = manager.getRepository(WorkflowNotificationTarget);
      const target = { workflowId: workflow.id, channelId: channel.id };
      if (await targets.existsBy(target)) {
        return { workflow, channel, changed: false };
      }
      await targets.insert(target);
      return { workflow, channel, changed: true };
    });
  }

  /**
   * Stops the Workflow named `name` notifying Channel `channelId`; its
   * Notifications so far are kept. `changed` is false when it did not.
   */
  stopNotifying(name: string, channelId: number): Promise<TargetChange> {
    return this.committing(async (manager) => {
      const workflow = await findWorkflow(manager, name);
      const channel = await existingChannel(manager, channelId);
      const { affected } = await manager
        .getRepository(WorkflowNotificationTarget)
        .delete({ workflowId: workflow.id, channelId: channel.id });
      return { workflow, channel, changed: (affected ?? 0) > 0 };
    });
  }

  /**
   * Runs `work` in a transaction, then tells readers of the definitions
   * once it has committed.
   */
  private async committing<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const result = await inTransaction(this.dataSource, work);
    this.definitions.changed();
    return result;
  }
}

/** A Workflow and Channel whose notification target was added or removed. */
export interface TargetChange {
  workflow: Workflow;
  channel: Channel;
  /** False when there was nothing to add or remove. */
  changed: boolean;
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

/**
 * `history`, once each Channel it names exists; `InvalidInputError`
 * otherwise.
 */
async function existingChannels(
  manager: EntityManager,
  history: WorkflowHistory,
): Promise<WorkflowHistory> {
  if (history.channels === 'all') return history;
  const found = await manager
    .getRepository(Channel)
    .findBy({ id: In(history.channels) });
  const known = new Set(found.map((channel) => channel.id));
  const missing = history.channels.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new InvalidInputError(
      `history.channels: no Channel with ID ${missing.join(', ')}; pero channels ls lists them`,
    );
  }
  return history;
}

/** Channel `id`; `NotFoundError` if none. */
async function existingChannel(
  manager: EntityManager,
  id: number,
): Promise<Channel> {
  const channel = await manager.getRepository(Channel).findOneBy({ id });
  if (channel === null) {
    throw new NotFoundError(
      `No Channel with ID ${id}; pero channels ls lists them`,
    );
  }
  return channel;
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
