import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, In } from 'typeorm';
import { effectiveWorkingDirectory } from '../agents/agent-resolution.js';
import { Agent } from '../persistence/entities/agent.entity.js';
import { LegacyChannelAgent } from '../persistence/entities/legacy-channel-agent.entity.js';
import {
  SETTINGS_ID,
  Settings,
} from '../persistence/entities/settings.entity.js';
import { Trigger } from '../persistence/entities/trigger.entity.js';
import { WorkflowNotificationTarget } from '../persistence/entities/workflow-notification-target.entity.js';
import { Workflow } from '../persistence/entities/workflow.entity.js';
import type { Schedule } from '../triggers/schedule.js';
import {
  type AgentDefinition,
  type Defaults,
  Definitions,
  type Route,
  type RouteQuery,
  type WorkflowDefinition,
} from './definitions.js';

/**
 * The definitions as the `settings`, `agents`, `workflows`, `triggers`,
 * and `workflow_notification_targets` tables hold them, and a legacy data
 * directory's Channel routes in `legacy_channel_agents`, read afresh on
 * every call. It opens no transaction of its own, so it can be
 * read inside a caller's: on SQLite's one connection, those reads see
 * what the transaction has written.
 */
@Injectable()
export class SqliteDefinitions extends Definitions {
  private readonly logger = new Logger('Definitions');
  private readonly listeners = new Set<() => void>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {
    super();
  }

  async defaults(): Promise<Defaults> {
    return defaultsOf(await this.settings());
  }

  async agent(name: string): Promise<AgentDefinition | null> {
    const row = await this.dataSource
      .getRepository(Agent)
      .findOneBy({ name: name.toLowerCase() });
    return row === null ? null : agentDefinition(row, await this.settings());
  }

  async agents(): Promise<AgentDefinition[]> {
    const settings = await this.settings();
    const rows = await this.dataSource
      .getRepository(Agent)
      .find({ order: { name: 'ASC' } });
    return rows.map((row) => agentDefinition(row, settings));
  }

  async mainAgent(): Promise<AgentDefinition | null> {
    const settings = await this.settings();
    if (settings.mainAgentId === null) return null;
    const row = await this.dataSource
      .getRepository(Agent)
      .findOneBy({ id: settings.mainAgentId });
    return row === null ? null : agentDefinition(row, settings);
  }

  async mainAgentName(): Promise<string | null> {
    return (await this.mainAgent())?.name ?? null;
  }

  /**
   * The Agent a legacy data directory's onboarding or `pero migrate`'s
   * source assigned `channel` to. A disabled Channel or Agent stays
   * silent, as it always did.
   */
  async route(channel: RouteQuery): Promise<Route> {
    const row = await this.dataSource
      .getRepository(LegacyChannelAgent)
      .findOneBy({ channelId: channel.id });
    if (row === null) {
      return {
        kind: 'unanswered',
        reason: { kind: 'undefined-agent', agent: null },
      };
    }
    if (!row.enabled) {
      return { kind: 'unanswered', reason: { kind: 'channel-disabled' } };
    }
    const agent = await this.agent(row.agentName);
    if (agent === null) {
      return {
        kind: 'unanswered',
        reason: { kind: 'undefined-agent', agent: row.agentName },
      };
    }
    if (!agent.enabled) {
      return {
        kind: 'unanswered',
        reason: { kind: 'disabled', agent: agent.name, file: null },
      };
    }
    return { kind: 'agent', agent };
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

  private settings(): Promise<Settings> {
    return this.dataSource
      .getRepository(Settings)
      .findOneByOrFail({ id: SETTINGS_ID });
  }
}

/** The defaults the settings row holds. */
export function defaultsOf(settings: Settings): Defaults {
  return {
    provider: settings.defaultProvider,
    providerDefaults: settings.providerDefaults,
    permissions: settings.defaultPermissions,
    timezone: settings.timezone,
    historyCarryover: settings.historyCarryover,
    historyRetentionDays: settings.historyRetentionDays,
    maxConcurrentRuns: settings.maxConcurrentRuns,
    dataFolder: settings.defaultWorkingDirectory,
    sharedInstructions: settings.sharedInstructions,
  };
}

/** The Agent in row `row`, following the defaults in `settings`. */
export function agentDefinition(
  row: Agent,
  settings: Settings,
): AgentDefinition {
  return {
    name: row.name,
    title: row.title,
    provider: row.provider,
    providerOptions: row.providerOptions,
    permissions: row.toolPolicy.permissions,
    workingDirectory: effectiveWorkingDirectory(row, settings),
    ownWorkingDirectory: row.workingDirectory,
    instructions: row.instructions,
    sharedInstructions: row.useSharedInstructions,
    skipGitRepoCheck: row.codexSkipGitRepoCheck,
    enabled: row.enabled,
  };
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
