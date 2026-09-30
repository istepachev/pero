import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, In } from 'typeorm';
import { HostConfigService } from '../host-config/host-config.service.js';
import { Trigger } from '../persistence/entities/trigger.entity.js';
import { WorkflowNotificationTarget } from '../persistence/entities/workflow-notification-target.entity.js';
import { Workflow } from '../persistence/entities/workflow.entity.js';
import type { Schedule } from '../triggers/schedule.js';
import {
  type AgentDefinition,
  type Defaults,
  Definitions,
  type Route,
  type WorkflowDefinition,
} from './definitions.js';
import { readLegacyDefaults } from './legacy-definitions.js';

/**
 * The Workflows as the `workflows`, `triggers`, and
 * `workflow_notification_targets` tables hold them, read afresh on every
 * call; a workspace's notes define the rest. It opens no transaction of
 * its own, so it can be read inside a caller's: on SQLite's one
 * connection, those reads see what the transaction has written.
 *
 * It is also a legacy data directory's definitions, which have no Agents
 * until `pero migrate` moves it to a workspace: every Channel is told so,
 * and the defaults it kept in `legacy_settings` still apply, with the
 * data folder `config.yaml` names.
 */
@Injectable()
export class SqliteDefinitions extends Definitions {
  private readonly logger = new Logger('Definitions');
  private readonly listeners = new Set<() => void>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    // Absent where only Workflows are read, as in `pero migrate`.
    @Optional() private readonly hostConfig?: HostConfigService,
  ) {
    super();
  }

  async defaults(): Promise<Defaults> {
    return {
      ...(await readLegacyDefaults(this.dataSource)),
      dataFolder: this.hostConfig?.dataFolder() ?? null,
    };
  }

  agent(): Promise<AgentDefinition | null> {
    return Promise.resolve(null);
  }

  agents(): Promise<AgentDefinition[]> {
    return Promise.resolve([]);
  }

  mainAgent(): Promise<AgentDefinition | null> {
    return Promise.resolve(null);
  }

  mainAgentName(): Promise<string | null> {
    return Promise.resolve(null);
  }

  route(): Promise<Route> {
    return Promise.resolve({
      kind: 'unanswered',
      reason: { kind: 'legacy' },
    });
  }

  async workflow(name: string): Promise<WorkflowDefinition | null> {
    const row = await this.dataSource
      .getRepository(Workflow)
      .findOneBy({ name: name.toLowerCase() });
    if (row === null) return null;
    return workflowDefinition(
      row,
      (await this.targets([row.id])).get(row.id),
      (await this.schedules([row.id])).get(row.id),
    );
  }

  async workflows(): Promise<WorkflowDefinition[]> {
    const rows = await this.dataSource
      .getRepository(Workflow)
      .find({ order: { name: 'ASC' } });
    const ids = rows.map((row) => row.id);
    const targets = await this.targets(ids);
    const schedules = await this.schedules(ids);
    return rows.map((row) =>
      workflowDefinition(row, targets.get(row.id), schedules.get(row.id)),
    );
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Tells listeners the definitions may have changed, once writes commit. */
  changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.logger.error(
          `A definitions listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** The Channels each of Workflows `ids` notifies, by Workflow ID. */
  private async targets(ids: number[]): Promise<Map<number, number[]>> {
    const rows = await this.dataSource
      .getRepository(WorkflowNotificationTarget)
      .find({
        where: { workflowId: In(ids) },
        order: { workflowId: 'ASC', channelId: 'ASC' },
      });
    const targets = new Map<number, number[]>();
    for (const { workflowId, channelId } of rows) {
      const channels = targets.get(workflowId) ?? [];
      channels.push(channelId);
      targets.set(workflowId, channels);
    }
    return targets;
  }

  /**
   * The enabled schedule Triggers of Workflows `ids`, oldest first, by
   * Workflow ID.
   */
  private async schedules(ids: number[]): Promise<Map<number, Schedule[]>> {
    const rows = await this.dataSource.getRepository(Trigger).find({
      where: { workflowId: In(ids), kind: 'schedule', enabled: true },
      order: { id: 'ASC' },
    });
    const schedules = new Map<number, Schedule[]>();
    for (const { workflowId, config, timezone } of rows) {
      // Every schedule has both; see `TriggersService.add`.
      if (typeof config.cron !== 'string' || timezone === null) continue;
      const list = schedules.get(workflowId) ?? [];
      list.push({ cron: config.cron, timezone });
      schedules.set(workflowId, list);
    }
    return schedules;
  }
}

/**
 * The Workflow in row `row`, which notifies the Channels `targets` and
 * runs on `schedules`.
 */
export function workflowDefinition(
  row: Workflow,
  targets: number[] = [],
  schedules: Schedule[] = [],
): WorkflowDefinition {
  return {
    name: row.name,
    title: row.title,
    agent: row.agentName,
    input: row.inputTemplate,
    history: row.history,
    targets,
    maxAttempts: row.maxAttempts,
    schedules,
    enabled: row.enabled,
  };
}
