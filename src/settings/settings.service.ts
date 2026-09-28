import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import {
  InvalidInputError,
  NotFoundError,
  parseInput,
} from '../common/errors.js';
import { withoutUndefined } from '../common/without-undefined.js';
import {
  mergeOptions,
  providerDefaultsSchema,
} from '../config/provider-options.js';
import {
  type SettingsUpdate,
  settingsUpdateSchema,
} from '../config/settings-input.js';
import { validateWorkingDirectory } from '../config/working-directory.js';
import { Agent } from '../persistence/entities/agent.entity.js';
import {
  SETTINGS_ID,
  Settings,
} from '../persistence/entities/settings.entity.js';
import { inTransaction } from '../persistence/transaction.js';

/** Reads and changes the installation defaults and limits. */
@Injectable()
export class SettingsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  get(): Promise<Settings> {
    return this.dataSource
      .getRepository(Settings)
      .findOneByOrFail({ id: SETTINGS_ID });
  }

  /**
   * Applies `input` and returns the new settings. Provider defaults change
   * only future Agents. A new default working directory moves every Agent
   * that follows it; their next turns start fresh Sessions there. A new
   * main Agent gets only the primary Channels onboarded from now on.
   */
  async update(input: SettingsUpdate): Promise<Settings> {
    const { providerDefaults, defaultWorkingDirectory, mainAgent, ...rest } =
      parseInput(settingsUpdateSchema, input);
    const folder =
      defaultWorkingDirectory === undefined
        ? undefined
        : await validateWorkingDirectory(defaultWorkingDirectory);

    return inTransaction(this.dataSource, async (manager) => {
      const repo = manager.getRepository(Settings);
      const current = await repo.findOneByOrFail({ id: SETTINGS_ID });
      const changes: Partial<Omit<Settings, 'mainAgent'>> =
        withoutUndefined(rest);
      if (providerDefaults !== undefined) {
        changes.providerDefaults = providerDefaultsSchema.parse({
          claude: mergeOptions(
            current.providerDefaults.claude,
            providerDefaults.claude,
          ),
          codex: mergeOptions(
            current.providerDefaults.codex,
            providerDefaults.codex,
          ),
        });
      }
      if (folder !== undefined && folder !== current.defaultWorkingDirectory) {
        changes.defaultWorkingDirectory = folder;
      }
      if (mainAgent !== undefined) {
        changes.mainAgentId =
          mainAgent === null
            ? null
            : (await mainAgentFor(manager, mainAgent)).id;
      }

      if (Object.keys(changes).length > 0) {
        await repo.update(SETTINGS_ID, changes);
      }
      return repo.findOneByOrFail({ id: SETTINGS_ID });
    });
  }

  /** The main Agent's name; null while none is chosen. */
  async mainAgentName(
    settings: Pick<Settings, 'mainAgentId'>,
  ): Promise<string | null> {
    if (settings.mainAgentId === null) return null;
    const agent = await this.dataSource
      .getRepository(Agent)
      .findOneByOrFail({ id: settings.mainAgentId });
    return agent.name;
  }
}

/** The Agent named `name`, which must be enabled to become the main Agent. */
async function mainAgentFor(
  manager: EntityManager,
  name: string,
): Promise<Agent> {
  const agent = await manager.getRepository(Agent).findOneBy({ name });
  if (agent === null) throw new NotFoundError(`No Agent named ${name}`);
  if (!agent.enabled) {
    throw new InvalidInputError(
      `Agent ${name} is disabled; enable it first with pero agents enable ${name}`,
    );
  }
  return agent;
}
