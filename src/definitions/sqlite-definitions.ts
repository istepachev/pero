import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, In } from 'typeorm';
import { effectiveWorkingDirectory } from '../agents/agent-resolution.js';
import { Agent } from '../persistence/entities/agent.entity.js';
import {
  SETTINGS_ID,
  Settings,
} from '../persistence/entities/settings.entity.js';
import { WorkflowNotificationTarget } from '../persistence/entities/workflow-notification-target.entity.js';
import { Workflow } from '../persistence/entities/workflow.entity.js';
import {
  type AgentDefinition,
  type Defaults,
  Definitions,
  type WorkflowDefinition,
} from './definitions.js';

/**
 * The definitions as the `settings`, `agents`, `workflows`, and
 * `workflow_notification_targets` tables hold them, read
 * afresh on every call. It opens no transaction of its own, so it can be
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

  async workflow(name: string): Promise<WorkflowDefinition | null> {
    const row = await this.dataSource
      .getRepository(Workflow)
      .findOneBy({ name: name.toLowerCase() });
    if (row === null) return null;
    return workflowDefinition(row, (await this.targets([row.id])).get(row.id));
  }

  async workflows(): Promise<WorkflowDefinition[]> {
    const rows = await this.dataSource
      .getRepository(Workflow)
      .find({ order: { name: 'ASC' } });
    const targets = await this.targets(rows.map((row) => row.id));
    return rows.map((row) => workflowDefinition(row, targets.get(row.id)));
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
 * The Workflow in row `row`, loaded with its Agent, which notifies the
 * Channels `targets`.
 */
export function workflowDefinition(
  row: Workflow,
  targets: number[] = [],
): WorkflowDefinition {
  return {
    name: row.name,
    title: row.title,
    agent: row.agentName,
    input: row.inputTemplate,
    history: row.history,
    targets,
    maxAttempts: row.maxAttempts,
    enabled: row.enabled,
  };
}
