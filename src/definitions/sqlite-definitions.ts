import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { effectiveWorkingDirectory } from '../agents/agent-resolution.js';
import { Agent } from '../persistence/entities/agent.entity.js';
import {
  SETTINGS_ID,
  Settings,
} from '../persistence/entities/settings.entity.js';
import {
  type AgentDefinition,
  type Defaults,
  Definitions,
} from './definitions.js';

/**
 * The definitions as the `settings` and `agents` tables hold them, read
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
