import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { parseInput } from '../common/errors.js';
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
   * that follows it, so their execution config version increases with it.
   */
  async update(input: SettingsUpdate): Promise<Settings> {
    const { providerDefaults, defaultWorkingDirectory, ...rest } = parseInput(
      settingsUpdateSchema,
      input,
    );
    const folder =
      defaultWorkingDirectory === undefined
        ? undefined
        : await validateWorkingDirectory(defaultWorkingDirectory);

    return inTransaction(this.dataSource, async (manager) => {
      const repo = manager.getRepository(Settings);
      const current = await repo.findOneByOrFail({ id: SETTINGS_ID });
      const changes: Partial<Settings> = withoutUndefined(rest);
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
      const folderChanged =
        folder !== undefined && folder !== current.defaultWorkingDirectory;
      if (folderChanged) changes.defaultWorkingDirectory = folder;

      if (Object.keys(changes).length > 0) {
        await repo.update(SETTINGS_ID, changes);
      }
      if (folderChanged) {
        await manager
          .createQueryBuilder()
          .update(Agent)
          .set({
            executionConfigVersion: () => '"execution_config_version" + 1',
          })
          .where('"working_directory" IS NULL')
          .execute();
      }
      return repo.findOneByOrFail({ id: SETTINGS_ID });
    });
  }
}
