import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataSourceOptions } from '../persistence/data-source-options.js';
import { MIGRATIONS } from '../persistence/migrations/index.js';
import { openDatabase } from '../persistence/open-database.js';
import {
  deleteLegacyAllowedChats,
  legacyDataFolder,
  readLegacyAllowedChats,
  readLegacyDefaults,
  readLegacyDefinitions,
  readLegacyTriggers,
  readLegacyWorkflows,
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
   * A database whose definitions `statements` wrote before plan steps 8.5
   * and 9.4 renamed their tables, migrated to the current schema.
   */
  async function legacy(statements: string[]): Promise<DataSource> {
    const old = await openDatabase({
      ...dataSourceOptions(database),
      migrations: MIGRATIONS.slice(0, -2),
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

  const channel = (key: string) =>
    `INSERT INTO "channels" ("integration_kind", "external_key", "address_json") ` +
    `VALUES ('telegram', '${key}', '{"chatId":"${key}"}')`;

  const workflow = (values: string) =>
    `INSERT INTO "workflows" ("name", "title", "agent_name", "input_template", ` +
    `"history_json", "max_attempts", "enabled") VALUES (${values})`;

  const trigger = (
    workflowId: number,
    kind: string,
    config: string,
    timezone: string | null,
    enabled: 0 | 1,
  ) =>
    `INSERT INTO "triggers" ("workflow_id", "kind", "config_json", "timezone", "enabled") ` +
    `VALUES (${workflowId}, '${kind}', '${config}', ${timezone === null ? 'NULL' : `'${timezone}'`}, ${enabled})`;

  describe('Workflows', () => {
    let db: DataSource;

    beforeEach(async () => {
      db = await legacy([
        channel('11'),
        channel('22'),
        workflow(
          `'weekly', 'Weekly', 'coach', 'Sum up the week.', ` +
            `'{"channels":[2],"messages":"all","hours":168,"runWhenEmpty":true}', 3, 1`,
        ),
        workflow(`'brief', NULL, 'main', 'Brief me.', NULL, 1, 0`),
        trigger(1, 'schedule', '{"cron":"0 12 * * 0"}', 'Europe/Berlin', 1),
        trigger(1, 'manual', '{}', null, 1),
        trigger(1, 'schedule', '{"cron":"0 7 * * *"}', 'UTC', 0),
        trigger(1, 'schedule', '{"cron":"30 18 * * 1-5"}', 'UTC', 1),
        trigger(2, 'schedule', '{"cron":"0 9 * * *"}', 'UTC', 1),
        `INSERT INTO "workflow_notification_targets" ("workflow_id", "channel_id") ` +
          `VALUES (1, 2), (1, 1)`,
      ]);
    });

    it('reads them by name, with their targets and enabled schedules', async () => {
      expect(await readLegacyWorkflows(db)).toEqual([
        {
          name: 'brief',
          title: null,
          agent: 'main',
          input: 'Brief me.',
          history: null,
          targets: [],
          maxAttempts: 1,
          // A disabled Workflow kept its schedules.
          schedules: [{ cron: '0 9 * * *', timezone: 'UTC' }],
          enabled: false,
        },
        {
          name: 'weekly',
          title: 'Weekly',
          agent: 'coach',
          input: 'Sum up the week.',
          history: {
            channels: [2],
            messages: 'all',
            hours: 168,
            runWhenEmpty: true,
          },
          targets: [1, 2],
          maxAttempts: 3,
          schedules: [
            { cron: '0 12 * * 0', timezone: 'Europe/Berlin' },
            { cron: '30 18 * * 1-5', timezone: 'UTC' },
          ],
          enabled: true,
        },
      ]);
    });

    it('reads every Trigger, oldest first', async () => {
      expect(await readLegacyTriggers(db)).toEqual([
        {
          id: 1,
          workflow: 'weekly',
          kind: 'schedule',
          cron: '0 12 * * 0',
          timezone: 'Europe/Berlin',
          enabled: true,
        },
        {
          id: 2,
          workflow: 'weekly',
          kind: 'manual',
          cron: null,
          timezone: null,
          enabled: true,
        },
        {
          id: 3,
          workflow: 'weekly',
          kind: 'schedule',
          cron: '0 7 * * *',
          timezone: 'UTC',
          enabled: false,
        },
        {
          id: 4,
          workflow: 'weekly',
          kind: 'schedule',
          cron: '30 18 * * 1-5',
          timezone: 'UTC',
          enabled: true,
        },
        {
          id: 5,
          workflow: 'brief',
          kind: 'schedule',
          cron: '0 9 * * *',
          timezone: 'UTC',
          enabled: true,
        },
      ]);
    });
  });

  it('reads the allowed chats, oldest first, and deletes them', async () => {
    const db = await legacy([
      `INSERT INTO "allowed_chats" ("integration_kind", "chat_key", "kind", "title") ` +
        `VALUES ('telegram', '-100222', 'group', 'Work'), ('telegram', '42', 'private', NULL)`,
    ]);

    const chats = await readLegacyAllowedChats(db);
    expect(chats).toEqual([
      { id: 1, chatKey: '-100222', title: 'Work' },
      { id: 2, chatKey: '42', title: null },
    ]);

    await deleteLegacyAllowedChats(db, [1]);
    expect(await readLegacyAllowedChats(db)).toEqual([
      { id: 2, chatKey: '42', title: null },
    ]);
    await deleteLegacyAllowedChats(db, []);
    expect(await readLegacyAllowedChats(db)).toHaveLength(1);
  });
});
