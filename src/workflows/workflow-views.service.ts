import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import type {
  TriggerView,
  WorkflowDetails,
  WorkflowView,
} from '../control/protocol.js';
import { Agent } from '../persistence/entities/agent.entity.js';
import { Trigger } from '../persistence/entities/trigger.entity.js';
import { Workflow } from '../persistence/entities/workflow.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { findWorkflow } from './workflows.service.js';

/** Workflows as the CLI shows them: their Agent and their Triggers. */
@Injectable()
export class WorkflowViews {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Every Workflow, by name. */
  list(): Promise<WorkflowView[]> {
    return inTransaction(this.dataSource, async (manager) => {
      const workflows = await manager.getRepository(Workflow).find({
        relations: { agent: true },
        order: { name: 'ASC' },
      });
      const counts = await triggerCounts(manager);
      return workflows.map((workflow) =>
        // The foreign key guarantees the Agent.
        workflowView(workflow, workflow.agent!, counts.get(workflow.id) ?? 0),
      );
    });
  }

  /** The Workflow named `name` with its Triggers; `NotFoundError` if none. */
  details(name: string): Promise<WorkflowDetails> {
    return inTransaction(this.dataSource, async (manager) => {
      const workflow = await findWorkflow(manager, name);
      const agent = await manager
        .getRepository(Agent)
        .findOneByOrFail({ id: workflow.agentId });
      const triggers = await manager
        .getRepository(Trigger)
        .find({ where: { workflowId: workflow.id }, order: { id: 'ASC' } });
      return {
        ...workflowView(workflow, agent, triggers.length),
        triggers: triggers.map((trigger) => triggerView(trigger, workflow)),
      };
    });
  }
}

/** A Trigger as the CLI shows it, with the Workflow it starts. */
export function triggerView(
  trigger: Trigger,
  workflow: Pick<Workflow, 'name'>,
): TriggerView {
  const { cron } = trigger.config;
  return {
    id: trigger.id,
    workflow: workflow.name,
    kind: trigger.kind,
    cron: typeof cron === 'string' ? cron : null,
    timezone: trigger.timezone,
    nextRunAt: trigger.nextRunAt?.toISOString() ?? null,
    lastRunAt: trigger.lastRunAt?.toISOString() ?? null,
    enabled: trigger.enabled,
  };
}

function workflowView(
  workflow: Workflow,
  agent: Agent,
  triggerCount: number,
): WorkflowView {
  return {
    name: workflow.name,
    title: workflow.title,
    agent: agent.name,
    agentEnabled: agent.enabled,
    inputTemplate: workflow.inputTemplate,
    enabled: workflow.enabled,
    concurrencyPolicy: workflow.concurrencyPolicy,
    maxAttempts: workflow.maxAttempts,
    triggerCount,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
  };
}

async function triggerCounts(
  manager: EntityManager,
): Promise<Map<number, number>> {
  const rows = await manager
    .getRepository(Trigger)
    .createQueryBuilder('t')
    .select('t.workflowId', 'workflowId')
    .addSelect('COUNT(*)', 'count')
    .groupBy('t.workflowId')
    .getRawMany<{ workflowId: number; count: number }>();
  return new Map(rows.map((row) => [row.workflowId, Number(row.count)]));
}
