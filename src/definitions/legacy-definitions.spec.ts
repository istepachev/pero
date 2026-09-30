import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataSourceOptions } from '../persistence/data-source-options.js';
import { MIGRATIONS } from '../persistence/migrations/index.js';
import { openDatabase } from '../persistence/open-database.js';
import {
  legacyDataFolder,
  readLegacyDefaults,
  readLegacyDefinitions,
} from './legacy-definitions.js';

describe('the legacy definitions', () => {
  let tmp: string;
  let database: string;
  let db: DataSource | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-legacy-'));
    database = join(tmp, 'pero.sqlite');
  });

  afterEach(async () => {
    if (db?.isInitialized) await db.destroy();
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * A database whose Agents and settings `statements` wrote before plan
   * step 8.5 renamed their tables, migrated to the current schema.
   */
  async function legacy(statements: string[]): Promise<DataSource> {
    const old = await openDatabase({
      ...dataSourceOptions(database),
      migrations: MIGRATIONS.slice(0, -1),
    });
    for (const sql of statements) await old.query(sql);
    await old.destroy();
    db = await openDatabase(dataSourceOptions(database));
    return db;
  }

  const agent = (values: string) =>
    `INSERT INTO "agents" ("name", "title", "provider", "instructions", ` +
    `"provider_options", "working_directory", "use_shared_instructions", ` +
    `"codex_skip_git_repo_check", "tool_policy_json", "enabled") VALUES (${values})`;

  it('reads the Agents by name, with their folders, and the main Agent', async () => {
    const db = await legacy([
      agent(
        `'notes', NULL, 'claude', NULL, '{"model":null,"effort":null}', ` +
          `NULL, 1, 0, '{}', 1`,
      ),
      agent(
        `'coder', 'Coder', 'codex', 'Write tests.', ` +
          `'{"model":"gpt-6","effort":"high"}', '/srv/code', 0, 1, ` +
          `'{"permissions":"bypass"}', 0`,
      ),
      `UPDATE "settings" SET "main_agent_id" = 2, ` +
        `"default_working_directory" = '/home/owner/vault'`,
    ]);

    expect(await readLegacyDefinitions(db)).toMatchObject({
      agents: [
        {
          name: 'coder',
          title: 'Coder',
          provider: 'codex',
          providerOptions: { model: 'gpt-6', effort: 'high' },
          permissions: 'bypass',
          workingDirectory: '/srv/code',
          ownWorkingDirectory: '/srv/code',
          instructions: 'Write tests.',
          sharedInstructions: false,
          skipGitRepoCheck: true,
          enabled: false,
        },
        {
          name: 'notes',
          title: null,
          provider: 'claude',
          providerOptions: { model: null, effort: null },
          // A policy stored before permissions existed asks.
          permissions: 'ask',
          workingDirectory: '/home/owner/vault',
          ownWorkingDirectory: null,
          instructions: null,
          sharedInstructions: true,
          skipGitRepoCheck: false,
          enabled: true,
        },
      ],
      mainAgent: 'coder',
    });
  });

  it('reads the defaults, and the old default working directory', async () => {
    const db = await legacy([
      `UPDATE "settings" SET "default_provider" = 'codex', ` +
        `"provider_defaults" = '{"claude":{"model":"opus","effort":null}}', ` +
        `"default_working_directory" = '/home/owner/vault', ` +
        `"shared_instructions" = 'Be kind.', "default_permissions" = 'bypass', ` +
        `"timezone" = 'Europe/Berlin', "history_carryover" = 5, ` +
        `"history_retention_days" = 30, "max_concurrent_runs" = 4`,
    ]);

    const defaults = {
      provider: 'codex',
      providerDefaults: {
        claude: { model: 'opus', effort: null },
        codex: { model: null, effort: null },
      },
      permissions: 'bypass',
      timezone: 'Europe/Berlin',
      historyCarryover: 5,
      historyRetentionDays: 30,
      maxConcurrentRuns: 4,
      dataFolder: '/home/owner/vault',
      sharedInstructions: 'Be kind.',
    };
    expect(await readLegacyDefaults(db)).toEqual(defaults);
    expect(await readLegacyDefinitions(db)).toEqual({
      defaults,
      agents: [],
      mainAgent: null,
    });
    expect(await legacyDataFolder(db)).toBe('/home/owner/vault');
  });

  it('has no data folder where none was set', async () => {
    expect(await legacyDataFolder(await legacy([]))).toBeNull();
  });

  it('refuses an Agent that follows a default folder that is unset', async () => {
    const db = await legacy([
      agent(`'notes', NULL, 'claude', NULL, '{}', NULL, 1, 0, '{}', 1`),
    ]);

    await expect(readLegacyDefinitions(db)).rejects.toThrow(/unset/);
  });

  it('refuses options a provider does not have', async () => {
    const db = await legacy([
      `UPDATE "settings" SET "default_working_directory" = '/vault'`,
      agent(
        `'notes', NULL, 'claude', NULL, '{"temperature":1}', NULL, 1, 0, '{}', 1`,
      ),
    ]);

    await expect(readLegacyDefinitions(db)).rejects.toThrow(/temperature/);
  });
});
