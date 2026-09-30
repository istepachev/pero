import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, In } from 'typeorm';
import type {
  NotificationTargetView,
  WorkflowDetails,
  WorkflowView,
} from '../control/protocol.js';
import { DefinitionIds } from '../definitions/definition-ids.js';
import {
  type AgentDefinition,
  Definitions,
  requireWorkflow,
  type WorkflowDefinition,
} from '../definitions/definitions.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import {
  triggerCountsWithin,
  triggerViewsWithin,
} from '../triggers/triggers.service.js';

/** Workflows as the CLI shows them: their Agent and their Triggers. */
@Injectable()
export class WorkflowViews {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly definitions: Definitions,
    private readonly ids: DefinitionIds,
  ) {}

  /** Every Workflow, by name. */
  async list(): Promise<WorkflowView[]> {
    const workflows = await this.definitions.workflows();
    const agents = new Map(
      (await this.definitions.agents()).map((agent) => [agent.name, agent]),
    );
    const names = await this.ids.workflowNames();
    const counts = new Map<string, number>();
    for (const [id, count] of await triggerCountsWithin(
      this.dataSource.manager,
    )) {
      const name = names.get(id);
      if (name !== undefined) counts.set(name, count);
    }
    return workflows.map((workflow) =>
      workflowView(
        workflow,
        agents.get(workflow.agent) ?? null,
        counts.get(workflow.name) ?? 0,
      ),
    );
  }

  /**
   * The Workflow named `name` with its Triggers and the Channels it
   * notifies; `NotFoundError` if none.
   */
  async details(name: string): Promise<WorkflowDetails> {
    const workflow = await requireWorkflow(this.definitions, name);
    const agent = await this.definitions.agent(workflow.agent);
    const id = await this.ids.workflowId(workflow.name);
    return inTransaction(this.dataSource, async (manager) => {
      const triggers = await triggerViewsWithin(manager, id, workflow.name);
      const channels = await manager.getRepository(Channel).find({
        where: { id: In(workflow.targets) },
        order: { id: 'ASC' },
      });
      return {
        ...workflowView(workflow, agent, triggers.length),
        triggers,
        targets: channels.map(targetView),
      };
    });
  }
}

function targetView(channel: Channel): NotificationTargetView {
  return {
    id: channel.id,
    integrationKind: channel.integrationKind,
    key: channel.externalKey,
    title: channel.title,
  };
}

function workflowView(
  workflow: WorkflowDefinition,
  agent: AgentDefinition | null,
  triggerCount: number,
): WorkflowView {
  return {
    name: workflow.name,
    title: workflow.title,
    agent: workflow.agent,
    agentEnabled: agent?.enabled ?? false,
    inputTemplate: workflow.input,
    enabled: workflow.enabled,
    maxAttempts: workflow.maxAttempts,
    history: workflow.history,
    triggerCount,
  };
}
