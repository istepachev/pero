import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionService } from '../../sessions/session.service.js';
import { scheduleFingerprint } from '../../scheduler/schedule.js';
import { dataSourceOptions } from '../data-source-options.js';
import { MIGRATIONS } from '../migrations/index.js';
import { openDatabase } from '../open-database.js';
import { inTransaction } from '../transaction.js';
import { Channel } from './channel.entity.js';
import { InboundUpdate } from './inbound-update.entity.js';
import { LegacyChannelAgent } from './legacy-channel-agent.entity.js';
import { Message } from './message.entity.js';
import { Notification } from './notification.entity.js';
import { ScheduleState } from './schedule-state.entity.js';
import { Session } from './session.entity.js';
import { WorkflowRun } from './workflow-run.entity.js';

/** The tables of state: what Pero records as it runs. */
const STATE_TABLES = [
  'channels',
  'inbound_updates',
  'messages',
  'notifications',
  'schedules',
  'sessions',
  'workflow_runs',
];

/** What legacy data directories defined, kept until plan step 11.6. */
const LEGACY_TABLES = [
  'legacy_agents',
  'legacy_allowed_chats',
  'legacy_channel_agents',
  'legacy_settings',
  'legacy_triggers',
  'legacy_workflow_notification_targets',
  'legacy_workflows',
];

const DOMAIN_TABLES = [...STATE_TABLES, ...LEGACY_TABLES];

// Beyond Number.MAX_SAFE_INTEGER, so a numeric round trip would change them.
const CHAT_ID = '-1009007199254740993';
const UPDATE_ID = '9007199254740993';

type Seeded = Awaited<ReturnType<typeof seed>>;

/**
 * Sets `values`, by column, in the settings row: `legacy_settings`, or
 * `settings` before plan step 8.5 renamed it.
 */
async function updateSettings(
  ds: DataSource,
  values: Record<string, unknown>,
): Promise<void> {
  const [{ table }] = await ds.query<{ table: string }[]>(
    `SELECT "name" AS "table" FROM "sqlite_master" ` +
      `WHERE "name" IN ('settings', 'legacy_settings')`,
  );
  const columns = Object.keys(values).map((column) => `"${column}" = ?`);
  await ds.query(
    `UPDATE "${table}" SET ${columns.join(', ')} WHERE "id" = 1`,
    Object.values(values),
  );
}

/** Workflow `id`, as `legacy_workflows` holds it. */
async function workflowRow(
  ds: DataSource,
  id: number,
): Promise<Record<string, unknown>> {
  const [row] = await ds.query<Record<string, unknown>[]>(
    `SELECT * FROM "legacy_workflows" WHERE "id" = ?`,
    [id],
  );
  return row!;
}

/** How many rows `table` holds. */
async function count(ds: DataSource, table: string): Promise<number> {
  const [{ rows }] = await ds.query<{ rows: number }[]>(
    `SELECT count(*) AS "rows" FROM "${table}"`,
  );
  return rows;
}

/** The settings row, as `legacy_settings` holds it. */
async function settingsRow(ds: DataSource): Promise<Record<string, unknown>> {
  const [row] = await ds.query<Record<string, unknown>[]>(
    `SELECT * FROM "legacy_settings" WHERE "id" = 1`,
  );
  return row!;
}

/** One row in every domain table, linked the way the runtime links them. */
async function seed(ds: DataSource) {
  await ds.query(
    `INSERT INTO "legacy_agents" ("name", "title", "provider", "instructions", ` +
      `"provider_options", "working_directory", "tool_policy_json") ` +
      `VALUES ('assistant', 'Personal assistant', 'claude', 'Be brief.', ` +
      `'{"model":"claude-opus-5-5","effort":"high"}', NULL, '{"permissions":"bypass"}')`,
  );
  const [agent] = await ds.query<
    { id: number; name: string; provider: 'claude' }[]
  >(
    `SELECT "id", "name", "provider" FROM "legacy_agents" WHERE "name" = 'assistant'`,
  );
  const channel = await ds.getRepository(Channel).save({
    integrationKind: 'telegram',
    externalKey: `${CHAT_ID}:7`,
    address: { chatId: CHAT_ID, messageThreadId: '7' },
    title: 'Groceries',
  });
  const route = await ds.getRepository(LegacyChannelAgent).save({
    channelId: channel.id,
    agentName: agent.name,
    enabled: true,
  });
  const session = await ds.getRepository(Session).save({
    agentName: agent.name,
    channelId: channel.id,
    providerSessionId: 'provider-session',
    provider: agent.provider,
    workingDirectory: '/home/owner/vault',
  });
  const [workflow] = await ds.query<{ id: number; name: string }[]>(
    `INSERT INTO "legacy_workflows" ("name", "agent_name", "input_template") ` +
      `VALUES ('daily-brief', ?, 'Summarize today.') RETURNING "id", "name"`,
    [agent!.name],
  );
  const [trigger] = await ds.query<{ id: number }[]>(
    `INSERT INTO "legacy_triggers" ("workflow_id", "kind", "config_json", "timezone") ` +
      `VALUES (?, 'schedule', '{"cron":"0 8 * * *"}', 'Europe/Berlin') RETURNING "id"`,
    [workflow!.id],
  );
  const schedule = await ds.getRepository(ScheduleState).save({
    workflowName: workflow!.name,
    fingerprint: scheduleFingerprint({
      cron: '0 8 * * *',
      timezone: 'Europe/Berlin',
    }),
    nextRunAt: new Date('2026-09-28T06:00:00.000Z'),
    lastRunAt: new Date('2026-09-27T06:00:00.000Z'),
  });
  const run = await ds.getRepository(WorkflowRun).save({
    workflowName: workflow!.name,
    triggerKey: 'schedule:2026-09-27T06:00:00Z',
    status: 'completed',
    executionConfig: { provider: 'claude', workingDirectory: '/vault' },
    startedAt: new Date('2026-09-27T06:00:01.000Z'),
    finishedAt: new Date('2026-09-27T06:02:00.000Z'),
    result: { text: 'Done.' },
    errorText: null,
  });
  await ds.query(
    `INSERT INTO "legacy_workflow_notification_targets" ("workflow_id", "channel_id") ` +
      `VALUES (?, ?)`,
    [workflow!.id, channel.id],
  );
  const notification = await ds.getRepository(Notification).save({
    workflowRunId: run.id,
    channelId: channel.id,
    payload: { text: 'Done.' },
    nextAttemptAt: null,
    providerMessageId: null,
  });
  const update = await ds.getRepository(InboundUpdate).save({
    integrationKind: 'telegram',
    externalUpdateId: UPDATE_ID,
  });
  await ds.query(
    `INSERT INTO "legacy_allowed_chats" ("integration_kind", "chat_key", "kind", "title") ` +
      `VALUES ('telegram', ?, 'group', 'Household')`,
    [CHAT_ID],
  );
  const message = await ds.getRepository(Message).save({
    channelId: channel.id,
    agentName: agent.name,
    sessionId: session.id,
    direction: 'out',
    origin: 'agent',
    externalMessageId: '9007199254740995',
    senderId: null,
    text: 'Added milk.',
  });
  await updateSettings(ds, { main_agent_id: agent!.id });
  return {
    agent: agent!,
    message,
    channel,
    route,
    session,
    workflow: workflow!,
    trigger: trigger!,
    schedule,
    run,
    notification,
    update,
  };
}

/** Every domain row, read back through the entities. */
async function readAll(ds: DataSource) {
  return {
    settings: await ds.query(`SELECT * FROM "legacy_settings"`),
    agents: await ds.query(`SELECT * FROM "legacy_agents"`),
    allowedChats: await ds.query(`SELECT * FROM "legacy_allowed_chats"`),
    channels: await ds.getRepository(Channel).find(),
    routes: await ds.getRepository(LegacyChannelAgent).find(),
    sessions: await ds.getRepository(Session).find(),
    workflows: await ds.query(`SELECT * FROM "legacy_workflows"`),
    triggers: await ds.query(`SELECT * FROM "legacy_triggers"`),
    schedules: await ds.getRepository(ScheduleState).find(),
    runs: await ds.getRepository(WorkflowRun).find(),
    targets: await ds.query(
      `SELECT * FROM "legacy_workflow_notification_targets"`,
    ),
    notifications: await ds.getRepository(Notification).find(),
    updates: await ds.getRepository(InboundUpdate).find(),
    messages: await ds.getRepository(Message).find(),
  };
}

function rejectsWith(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({ driverError: { code } });
}

describe('domain entities', () => {
  let tmp: string;
  let database: string;
  let ds: DataSource | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-db-'));
    database = join(tmp, 'pero.sqlite');
  });

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
    ds = undefined;
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function open(): Promise<DataSource> {
    ds = await openDatabase(dataSourceOptions(database));
    return ds;
  }

  async function tables(db: DataSource): Promise<string[]> {
    const rows: { name: string }[] = await db.query(
      `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' ` +
        `ORDER BY "name"`,
    );
    return rows.map((row) => row.name);
  }

  it('reverts to the settings table alone and migrates again', async () => {
    const db = await open();
    expect(await tables(db)).toEqual(expect.arrayContaining(DOMAIN_TABLES));

    // Legacy Workflows, legacy definitions, Channel routes, schedule state, names in state, history retention, Notification delivery,
    // history, attempts, skipped counts, default permissions, message history,
    // the allowlist, the Session resume migration, then the domain tables.
    for (let i = 0; i < 15; i++) {
      await db.undoLastMigration({ transaction: 'each' });
    }
    expect(await tables(db)).toEqual([
      'migrations',
      'settings',
      'sqlite_sequence',
    ]);
    expect(await db.query(`SELECT "id" FROM "settings"`)).toEqual([{ id: 1 }]);

    await db.runMigrations({ transaction: 'each' });
    expect(await tables(db)).toEqual(expect.arrayContaining(DOMAIN_TABLES));
    await seed(db);
  });

  it("gives existing Sessions their Agent's provider and folder, and reverts to config versions", async () => {
    const db = await open();
    await updateSettings(db, {
      default_working_directory: '/home/owner/vault',
    });
    const seeded = await seed(db);

    // Legacy Workflows, legacy definitions, Channel routes, schedule state, names in state, history retention, Notification delivery,
    // Workflow history, attempts, skipped counts, default permissions, message
    // history, the allowlist, then the Session resume migration.
    for (let i = 0; i < 14; i++) {
      await db.undoLastMigration({ transaction: 'each' });
    }
    expect(
      await db.query(
        `SELECT "agent_config_version", "provider_session_id" FROM "sessions"`,
      ),
    ).toEqual([
      { agent_config_version: 1, provider_session_id: 'provider-session' },
    ]);
    expect(
      await db.query(`SELECT "name", "execution_config_version" FROM "agents"`),
    ).toEqual([{ name: 'assistant', execution_config_version: 1 }]);

    // The Agent's own folder wins over the default it no longer follows.
    await db.query(
      `UPDATE "agents" SET "working_directory" = '/home/owner/own'`,
    );
    await db.runMigrations({ transaction: 'each' });

    expect(
      await db
        .getRepository(Session)
        .findOneByOrFail({ id: seeded.session.id }),
    ).toMatchObject({
      provider: 'claude',
      workingDirectory: '/home/owner/own',
      providerSessionId: 'provider-session',
      status: 'active',
    });
    expect(await db.getRepository(Channel).count()).toBe(1);
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('keeps the settings row through the allowlist migration and back', async () => {
    const db = await open();
    await updateSettings(db, {
      default_working_directory: '/home/owner/vault',
      shared_instructions: 'Be kind.',
    });
    await seed(db);

    // Legacy Workflows, legacy definitions, Channel routes, schedule state, names in state, history retention, Notification delivery,
    // Workflow history, attempts, skipped counts, default permissions, message
    // history, then the allowlist.
    for (let i = 0; i < 13; i++) {
      await db.undoLastMigration({ transaction: 'each' });
    }
    expect(await tables(db)).not.toContain('allowed_chats');
    expect(
      await db.query(
        `SELECT "default_working_directory", "shared_instructions" FROM "settings"`,
      ),
    ).toEqual([
      {
        default_working_directory: '/home/owner/vault',
        shared_instructions: 'Be kind.',
      },
    ]);

    await db.runMigrations({ transaction: 'each' });
    expect(await settingsRow(db)).toMatchObject({
      default_working_directory: '/home/owner/vault',
      shared_instructions: 'Be kind.',
      main_agent_id: null,
    });
    expect(await db.getRepository(Channel).find()).toEqual([
      expect.objectContaining({ title: null }),
    ]);
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('keeps the settings row through the message history migration and back', async () => {
    const db = await open();
    const { agent } = await seed(db);
    await updateSettings(db, {
      shared_instructions: 'Be kind.',
      history_carryover: 10,
    });

    // Legacy Workflows, legacy definitions, Channel routes, schedule state, names in state, history retention, Notification delivery,
    // Workflow history, attempts, skipped counts, default permissions, then
    // message history.
    for (let i = 0; i < 12; i++) {
      await db.undoLastMigration({ transaction: 'each' });
    }
    expect(await tables(db)).not.toContain('messages');
    expect(
      await db.query(
        `SELECT "shared_instructions", "main_agent_id" FROM "settings"`,
      ),
    ).toEqual([{ shared_instructions: 'Be kind.', main_agent_id: agent.id }]);

    await db.runMigrations({ transaction: 'each' });
    expect(await settingsRow(db)).toMatchObject({
      shared_instructions: 'Be kind.',
      main_agent_id: agent.id,
      history_carryover: 50,
    });
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('keeps the settings row through the default permissions migration and back', async () => {
    const db = await open();
    const { agent } = await seed(db);
    await updateSettings(db, {
      shared_instructions: 'Be kind.',
      history_carryover: 10,
      default_permissions: 'bypass',
    });

    // Legacy Workflows, legacy definitions, Channel routes, schedule state, names in state, history retention, Notification delivery,
    // history, attempts, skipped counts, then default permissions.
    for (let i = 0; i < 11; i++) {
      await db.undoLastMigration({ transaction: 'each' });
    }
    const columns = await db.query<{ name: string }[]>(
      `SELECT "name" FROM pragma_table_info('settings')`,
    );
    expect(columns.map((column) => column.name)).not.toContain(
      'default_permissions',
    );
    expect(
      await db.query(
        `SELECT "shared_instructions", "main_agent_id", "history_carryover" FROM "settings"`,
      ),
    ).toEqual([
      {
        shared_instructions: 'Be kind.',
        main_agent_id: agent.id,
        history_carryover: 10,
      },
    ]);

    await db.runMigrations({ transaction: 'each' });
    expect(await settingsRow(db)).toMatchObject({
      shared_instructions: 'Be kind.',
      history_carryover: 10,
      default_permissions: 'ask',
    });
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('keeps runs and their Notifications through the skipped count migration and back', async () => {
    const db = await open();
    const { run, notification } = await seed(db);
    await db.getRepository(WorkflowRun).update(run.id, { skippedCount: 4 });

    // Legacy Workflows, legacy definitions, Channel routes, schedule state, names in state, history retention, Notification delivery,
    // history, attempts, then skipped counts.
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    const columns = await db.query<{ name: string }[]>(
      `SELECT "name" FROM pragma_table_info('workflow_runs')`,
    );
    expect(columns.map((column) => column.name)).not.toContain('skipped_count');
    expect(
      await db.query(`SELECT "id", "trigger_key" FROM "workflow_runs"`),
    ).toEqual([{ id: run.id, trigger_key: run.triggerKey }]);
    expect(await db.query(`SELECT "id" FROM "notifications"`)).toEqual([
      { id: notification.id },
    ]);

    await db.runMigrations({ transaction: 'each' });
    expect(
      await db.getRepository(WorkflowRun).findOneByOrFail({ id: run.id }),
    ).toMatchObject({ triggerKey: run.triggerKey, skippedCount: 0 });
    expect(await db.getRepository(Notification).count()).toBe(1);
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('keeps Workflows and their runs through the attempts migration and back', async () => {
    const db = await open();
    const { workflow, run, notification } = await seed(db);
    expect(await workflowRow(db, workflow.id)).toMatchObject({
      max_attempts: 1,
    });
    await db.query(`UPDATE "legacy_workflows" SET "max_attempts" = 3`);

    // Legacy Workflows, legacy definitions, Channel routes, schedule state, names in state, history retention, Notification delivery,
    // history, then attempts.
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    const columns = await db.query<{ name: string }[]>(
      `SELECT "name" FROM pragma_table_info('workflows')`,
    );
    expect(columns.map((column) => column.name)).not.toContain('max_attempts');
    expect(await db.query(`SELECT "id", "name" FROM "workflows"`)).toEqual([
      { id: workflow.id, name: workflow.name },
    ]);
    expect(await db.query(`SELECT "id" FROM "workflow_runs"`)).toEqual([
      { id: run.id },
    ]);
    expect(await db.query(`SELECT "id" FROM "notifications"`)).toEqual([
      { id: notification.id },
    ]);

    await db.runMigrations({ transaction: 'each' });
    expect(await workflowRow(db, workflow.id)).toMatchObject({
      name: workflow.name,
      max_attempts: 1,
    });
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('keeps Workflows and their runs through the history migration and back', async () => {
    const db = await open();
    const { workflow, run } = await seed(db);
    expect(await workflowRow(db, workflow.id)).toMatchObject({
      history_json: null,
    });
    await db.query(
      `UPDATE "legacy_workflows" SET "history_json" = ` +
        `'{"channels":[1,3],"messages":"all","hours":24,"runWhenEmpty":true}'`,
    );

    // Legacy Workflows, legacy definitions, Channel routes, schedule state, names in state, history retention, Notification delivery,
    // then history.
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    const columns = await db.query<{ name: string }[]>(
      `SELECT "name" FROM pragma_table_info('workflows')`,
    );
    expect(columns.map((column) => column.name)).not.toContain('history_json');
    expect(await db.query(`SELECT "id" FROM "workflow_runs"`)).toEqual([
      { id: run.id },
    ]);

    await db.runMigrations({ transaction: 'each' });
    expect(await workflowRow(db, workflow.id)).toMatchObject({
      name: workflow.name,
      history_json: null,
    });
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('keeps messages and Notifications through the delivery migration and back', async () => {
    const db = await open();
    const { message, notification } = await seed(db);
    await db
      .getRepository(Notification)
      .update(notification.id, { lastError: 'Telegram is unreachable' });
    const delivered = await db.getRepository(Message).save({
      channelId: message.channelId,
      agentName: null,
      sessionId: null,
      direction: 'out',
      origin: 'workflow',
      externalMessageId: '12',
      senderId: null,
      text: 'Done.',
      notificationId: notification.id,
    });

    // Legacy Workflows, legacy definitions, Channel routes, schedule state, names in state, history retention, then Notification
    // delivery.
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    const columns = async (table: string) =>
      (
        await db.query<{ name: string }[]>(
          `SELECT "name" FROM pragma_table_info('${table}')`,
        )
      ).map((column) => column.name);
    expect(await columns('notifications')).not.toContain('last_error');
    expect(await columns('messages')).not.toContain('notification_id');
    // A Workflow's message cannot be kept without its origin.
    expect(await db.query(`SELECT "id" FROM "messages"`)).toEqual([
      { id: message.id },
    ]);
    await rejectsWith(
      db.query(`UPDATE "messages" SET "origin" = 'workflow'`),
      'SQLITE_CONSTRAINT_CHECK',
    );

    await db.runMigrations({ transaction: 'each' });
    expect(
      await db.getRepository(Message).findOneByOrFail({ id: message.id }),
    ).toMatchObject({ text: 'Added milk.', notificationId: null });
    expect(
      await db.getRepository(Message).findOneBy({ id: delivered.id }),
    ).toBeNull();
    expect(
      await db
        .getRepository(Notification)
        .findOneByOrFail({ id: notification.id }),
    ).toMatchObject({ lastError: null });
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('keeps the settings row through the history retention migration and back', async () => {
    const db = await open();
    const { agent } = await seed(db);
    expect(await settingsRow(db)).toMatchObject({
      history_retention_days: null,
    });
    await updateSettings(db, {
      history_carryover: 10,
      history_retention_days: 30,
    });

    // Legacy Workflows, legacy definitions, Channel routes, schedule state, names in state, then history retention.
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    const columns = await db.query<{ name: string }[]>(
      `SELECT "name" FROM pragma_table_info('settings')`,
    );
    expect(columns.map((column) => column.name)).not.toContain(
      'history_retention_days',
    );
    expect(
      await db.query(
        `SELECT "main_agent_id", "history_carryover" FROM "settings"`,
      ),
    ).toEqual([{ main_agent_id: agent.id, history_carryover: 10 }]);

    await db.runMigrations({ transaction: 'each' });
    expect(await settingsRow(db)).toMatchObject({
      history_carryover: 10,
      history_retention_days: null,
    });
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('names the Agents and Workflows of a 0.1.0 database, and resumes its Sessions', async () => {
    // 0.1.0 shipped every migration up to history retention.
    const old = await openDatabase({
      ...dataSourceOptions(database),
      migrations: MIGRATIONS.slice(0, -5),
    });
    const agentColumns = `"name", "provider", "provider_options", "tool_policy_json"`;
    const agentValues = (name: string) =>
      `'${name}', 'claude', '{"model":null,"effort":null}', '{"permissions":"ask"}'`;
    for (const sql of [
      `INSERT INTO "agents" (${agentColumns}) VALUES (${agentValues('main')})`,
      `INSERT INTO "agents" (${agentColumns}) VALUES (${agentValues('coach')})`,
      `INSERT INTO "channels" ("integration_kind", "external_key", "address_json", "agent_id") ` +
        `VALUES ('telegram', '42', '{"chatId":"42"}', 2)`,
      `INSERT INTO "sessions" ("agent_id", "channel_id", "provider_session_id", "provider", "working_directory", "status") ` +
        `VALUES (2, 1, 'provider-old', 'claude', '/vault', 'closed')`,
      `INSERT INTO "sessions" ("agent_id", "channel_id", "provider_session_id", "provider", "working_directory") ` +
        `VALUES (2, 1, 'provider-1', 'claude', '/vault')`,
      `INSERT INTO "workflows" ("name", "agent_id", "input_template") VALUES ('brief', 1, 'Sum up.')`,
      `INSERT INTO "triggers" ("workflow_id", "kind", "config_json") VALUES (1, 'manual', '{}')`,
      `INSERT INTO "workflow_runs" ("workflow_id", "trigger_id", "trigger_key", "status") ` +
        `VALUES (1, 1, 'manual:first', 'completed')`,
      `INSERT INTO "notifications" ("workflow_run_id", "channel_id", "payload", "status") ` +
        `VALUES (1, 1, '{"text":"Done."}', 'delivered')`,
      `INSERT INTO "messages" ("channel_id", "agent_id", "session_id", "direction", "origin", "external_message_id", "sender_id", "text") ` +
        `VALUES (1, 2, 2, 'in', 'user', '1', '42', 'Hi')`,
      `INSERT INTO "messages" ("channel_id", "agent_id", "session_id", "direction", "origin", "external_message_id", "text") ` +
        `VALUES (1, 2, 2, 'out', 'agent', '2', 'echo: Hi')`,
      `INSERT INTO "messages" ("channel_id", "direction", "origin", "external_message_id", "text") ` +
        `VALUES (1, 'out', 'pero', '3', 'Pero here.')`,
      `INSERT INTO "messages" ("channel_id", "direction", "origin", "external_message_id", "text", "notification_id") ` +
        `VALUES (1, 'out', 'workflow', '4', 'Done.', 1)`,
    ]) {
      await old.query(sql);
    }
    await old.destroy();

    const db = await open();
    expect(
      await db.query(
        `SELECT "id", "agent_name", "status" FROM "sessions" ORDER BY "id"`,
      ),
    ).toEqual([
      { id: 1, agent_name: 'coach', status: 'closed' },
      { id: 2, agent_name: 'coach', status: 'active' },
    ]);
    expect(
      await db.query(
        `SELECT "id", "agent_name", "origin" FROM "messages" ORDER BY "id"`,
      ),
    ).toEqual([
      { id: 1, agent_name: 'coach', origin: 'user' },
      { id: 2, agent_name: 'coach', origin: 'agent' },
      { id: 3, agent_name: null, origin: 'pero' },
      { id: 4, agent_name: null, origin: 'workflow' },
    ]);
    expect(
      await db.query(
        `SELECT "id", "workflow_name", "trigger_key" FROM "workflow_runs"`,
      ),
    ).toEqual([{ id: 1, workflow_name: 'brief', trigger_key: 'manual:first' }]);
    expect(
      await db.query(
        `SELECT "id", "name", "agent_name" FROM "legacy_workflows"`,
      ),
    ).toEqual([{ id: 1, name: 'brief', agent_name: 'main' }]);
    expect(await count(db, 'legacy_triggers')).toBe(1);
    expect(await db.getRepository(LegacyChannelAgent).find()).toEqual([
      { channelId: 1, agentName: 'coach', enabled: true },
    ]);
    expect(await db.getRepository(Notification).count()).toBe(1);
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);

    // The next turn of the Channel's Agent resumes its provider session.
    const session = await inTransaction(db, (manager) =>
      new SessionService(db).beginWithin(manager, 1, {
        name: 'coach',
        provider: 'claude',
        workingDirectory: '/vault',
      }),
    );
    expect(session).toMatchObject({ id: 2, providerSessionId: 'provider-1' });
  });

  it('reverts names in state to IDs and migrates again', async () => {
    const db = await open();
    const { agent, session, message, workflow, run } = await seed(db);

    // Legacy Workflows, legacy definitions, Channel routes, schedule state, then names in state.
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    const columns = async (table: string) =>
      (
        await db.query<{ name: string }[]>(
          `SELECT "name" FROM pragma_table_info('${table}')`,
        )
      ).map((column) => column.name);
    expect(await columns('sessions')).not.toContain('agent_name');
    expect(await columns('messages')).not.toContain('agent_name');
    expect(await columns('workflow_runs')).not.toContain('workflow_name');
    expect(await columns('workflows')).not.toContain('agent_name');
    expect(await db.query(`SELECT "id", "agent_id" FROM "sessions"`)).toEqual([
      { id: session.id, agent_id: agent.id },
    ]);
    expect(await db.query(`SELECT "id", "agent_id" FROM "messages"`)).toEqual([
      { id: message.id, agent_id: agent.id },
    ]);
    expect(
      await db.query(`SELECT "id", "workflow_id" FROM "workflow_runs"`),
    ).toEqual([{ id: run.id, workflow_id: workflow.id }]);
    expect(await db.query(`SELECT "id", "agent_id" FROM "workflows"`)).toEqual([
      { id: workflow.id, agent_id: agent.id },
    ]);
    await rejectsWith(
      db.query(`UPDATE "sessions" SET "agent_id" = 999`),
      'SQLITE_CONSTRAINT_FOREIGNKEY',
    );

    await db.runMigrations({ transaction: 'each' });
    expect(
      await db.getRepository(Session).findOneByOrFail({ id: session.id }),
    ).toMatchObject({ agentName: 'assistant', status: 'active' });
    expect(
      await db.getRepository(Message).findOneByOrFail({ id: message.id }),
    ).toMatchObject({ agentName: 'assistant' });
    expect(
      await db.getRepository(WorkflowRun).findOneByOrFail({ id: run.id }),
    ).toMatchObject({ workflowName: 'daily-brief' });
    expect(await workflowRow(db, workflow.id)).toMatchObject({
      agent_name: 'assistant',
    });
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('moves the times of enabled schedules into their own table', async () => {
    const old = await openDatabase({
      ...dataSourceOptions(database),
      migrations: MIGRATIONS.slice(0, -4),
    });
    const trigger = (
      cron: string,
      enabled: number,
      next: string | null,
      last: string | null,
    ) =>
      old.query(
        `INSERT INTO "triggers" ("workflow_id", "kind", "config_json", "timezone", "enabled", "next_run_at", "last_run_at") ` +
          `VALUES (1, 'schedule', ?, 'Europe/Berlin', ?, ?, ?)`,
        [JSON.stringify({ cron }), enabled, next, last],
      );
    for (const sql of [
      `INSERT INTO "agents" ("name", "provider", "provider_options", "tool_policy_json") ` +
        `VALUES ('coach', 'claude', '{"model":null,"effort":null}', '{"permissions":"ask"}')`,
      `INSERT INTO "workflows" ("name", "agent_name", "input_template") VALUES ('brief', 'coach', 'Sum up.')`,
      `INSERT INTO "triggers" ("workflow_id", "kind", "config_json") VALUES (1, 'manual', '{}')`,
    ]) {
      await old.query(sql);
    }
    await trigger(
      '0 8 * * *',
      1,
      '2026-09-28 06:00:00.000',
      '2026-09-27 06:00:03.000',
    );
    await trigger('0 12 * * *', 0, null, '2026-09-20 10:00:00.000');
    await trigger('0 18 * * *', 1, null, null);
    await old.destroy();

    const db = await open();
    expect(
      await db.query(
        `SELECT "workflow_name", "fingerprint", "next_run_at", "last_run_at" FROM "schedules"`,
      ),
    ).toEqual([
      {
        workflow_name: 'brief',
        fingerprint: scheduleFingerprint({
          cron: '0 8 * * *',
          timezone: 'Europe/Berlin',
        }),
        next_run_at: '2026-09-28 06:00:00.000',
        last_run_at: '2026-09-27 06:00:03.000',
      },
    ]);
    const columns = await db.query<{ name: string }[]>(
      `SELECT "name" FROM pragma_table_info('legacy_triggers')`,
    );
    expect(columns.map((column) => column.name)).not.toContain('next_run_at');
    expect(await count(db, 'legacy_triggers')).toBe(4);
  });

  it('gives schedule times back to their Triggers and migrates again', async () => {
    const db = await open();
    const { trigger, schedule } = await seed(db);

    // Legacy Workflows, legacy definitions, Channel routes, then schedule state.
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    expect(await tables(db)).not.toContain('schedules');
    expect(
      await db.query(
        `SELECT "id", "next_run_at", "last_run_at" FROM "triggers"`,
      ),
    ).toEqual([
      {
        id: trigger.id,
        next_run_at: '2026-09-28 06:00:00.000',
        last_run_at: '2026-09-27 06:00:00.000',
      },
    ]);

    await db.runMigrations({ transaction: 'each' });
    expect(await db.getRepository(ScheduleState).find()).toEqual([
      expect.objectContaining({
        workflowName: schedule.workflowName,
        fingerprint: schedule.fingerprint,
        nextRunAt: schedule.nextRunAt,
        lastRunAt: schedule.lastRunAt,
      }),
    ]);
  });

  it("moves each Channel's Agent and state into the legacy table", async () => {
    const old = await openDatabase({
      ...dataSourceOptions(database),
      migrations: MIGRATIONS.slice(0, -3),
    });
    const agentColumns = `"name", "provider", "provider_options", "tool_policy_json"`;
    const agentValues = (name: string) =>
      `'${name}', 'claude', '{"model":null,"effort":null}', '{"permissions":"ask"}'`;
    for (const sql of [
      `INSERT INTO "agents" (${agentColumns}) VALUES (${agentValues('main')})`,
      `INSERT INTO "agents" (${agentColumns}) VALUES (${agentValues('coach')})`,
      `INSERT INTO "channels" ("integration_kind", "external_key", "address_json", "title", "agent_id") ` +
        `VALUES ('telegram', '42', '{"chatId":"42"}', 'Home', 1)`,
      `INSERT INTO "channels" ("integration_kind", "external_key", "address_json", "title", "agent_id", "enabled") ` +
        `VALUES ('telegram', '42:7', '{"chatId":"42","messageThreadId":"7"}', 'Running', 2, 0)`,
      `INSERT INTO "sessions" ("agent_name", "channel_id", "provider", "working_directory") ` +
        `VALUES ('coach', 2, 'claude', '/vault')`,
    ]) {
      await old.query(sql);
    }
    await old.destroy();

    const db = await open();
    expect(await db.getRepository(LegacyChannelAgent).find()).toEqual([
      { channelId: 1, agentName: 'main', enabled: true },
      { channelId: 2, agentName: 'coach', enabled: false },
    ]);
    expect(await db.query(`SELECT * FROM "channels" ORDER BY "id"`)).toEqual([
      expect.objectContaining({ id: 1, external_key: '42', title: 'Home' }),
      expect.objectContaining({
        id: 2,
        external_key: '42:7',
        title: 'Running',
      }),
    ]);
    const columns = (
      await db.query<{ name: string }[]>(
        `SELECT "name" FROM pragma_table_info('channels')`,
      )
    ).map((column) => column.name);
    expect(columns).not.toContain('agent_id');
    expect(columns).not.toContain('enabled');
    expect(await db.getRepository(Session).count()).toBe(1);
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('gives Channels their Agent and state back, and migrates again', async () => {
    const db = await open();
    const { agent, channel } = await seed(db);
    await db
      .getRepository(LegacyChannelAgent)
      .update(channel.id, { enabled: false });

    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    expect(await tables(db)).not.toContain('legacy_channel_agents');
    expect(
      await db.query(`SELECT "id", "agent_id", "enabled" FROM "channels"`),
    ).toEqual([{ id: channel.id, agent_id: agent.id, enabled: 0 }]);
    await rejectsWith(
      db.query(`UPDATE "channels" SET "agent_id" = 999`),
      'SQLITE_CONSTRAINT_FOREIGNKEY',
    );

    await db.runMigrations({ transaction: 'each' });
    expect(await db.getRepository(LegacyChannelAgent).find()).toEqual([
      { channelId: channel.id, agentName: agent.name, enabled: false },
    ]);
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('keeps the Agents and settings, whole, in legacy tables', async () => {
    const old = await openDatabase({
      ...dataSourceOptions(database),
      migrations: MIGRATIONS.slice(0, -2),
    });
    await old.query(
      `INSERT INTO "agents" ("name", "provider", "provider_options", "tool_policy_json", "working_directory") ` +
        `VALUES ('coach', 'codex', '{"model":"gpt-6","effort":null}', '{"permissions":"bypass"}', '/srv/code')`,
    );
    await old.query(
      `UPDATE "settings" SET "main_agent_id" = 1, "shared_instructions" = 'Be kind.'`,
    );
    await old.destroy();

    const db = await open();
    expect(await tables(db)).not.toContain('agents');
    expect(await tables(db)).not.toContain('settings');
    expect(
      await db.query(
        `SELECT "id", "name", "provider", "provider_options", "working_directory" FROM "legacy_agents"`,
      ),
    ).toEqual([
      {
        id: 1,
        name: 'coach',
        provider: 'codex',
        provider_options: '{"model":"gpt-6","effort":null}',
        working_directory: '/srv/code',
      },
    ]);
    expect(await settingsRow(db)).toMatchObject({
      main_agent_id: 1,
      shared_instructions: 'Be kind.',
    });
    // The main Agent's foreign key follows the renamed table.
    await rejectsWith(
      db.query(`DELETE FROM "legacy_agents"`),
      'SQLITE_CONSTRAINT_TRIGGER',
    );
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('gives the Agents and settings their tables back, and migrates again', async () => {
    const db = await open();
    const { agent } = await seed(db);

    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
    expect(await tables(db)).toEqual(
      expect.arrayContaining(['agents', 'settings']),
    );
    expect(await tables(db)).not.toContain('legacy_agents');
    expect(await db.query(`SELECT "main_agent_id" FROM "settings"`)).toEqual([
      { main_agent_id: agent.id },
    ]);
    expect(await db.query(`SELECT "name" FROM "agents"`)).toEqual([
      { name: 'assistant' },
    ]);

    await db.runMigrations({ transaction: 'each' });
    expect(await settingsRow(db)).toMatchObject({ main_agent_id: agent.id });
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('holds only state, beside the legacy tables', async () => {
    const db = await open();
    expect(
      (await tables(db)).filter(
        (table) =>
          !['migrations', 'sqlite_sequence'].includes(table) &&
          !table.startsWith('legacy_'),
      ),
    ).toEqual(STATE_TABLES);
    expect((await tables(db)).filter((t) => t.startsWith('legacy_'))).toEqual(
      LEGACY_TABLES,
    );
  });

  it('keeps the Workflows, their Triggers and targets, and allowed chats, whole, in legacy tables', async () => {
    const old = await openDatabase({
      ...dataSourceOptions(database),
      migrations: MIGRATIONS.slice(0, -1),
    });
    for (const sql of [
      `INSERT INTO "channels" ("integration_kind", "external_key", "address_json") ` +
        `VALUES ('telegram', '42', '{"chatId":"42"}')`,
      `INSERT INTO "workflows" ("name", "agent_name", "input_template", "max_attempts") ` +
        `VALUES ('brief', 'coach', 'Sum up.', 2)`,
      `INSERT INTO "triggers" ("workflow_id", "kind", "config_json", "timezone") ` +
        `VALUES (1, 'schedule', '{"cron":"0 8 * * *"}', 'Europe/Berlin')`,
      `INSERT INTO "workflow_notification_targets" ("workflow_id", "channel_id") VALUES (1, 1)`,
      `INSERT INTO "allowed_chats" ("integration_kind", "chat_key", "kind", "title") ` +
        `VALUES ('telegram', '42', 'private', 'Owner')`,
      `INSERT INTO "workflow_runs" ("workflow_name", "trigger_id", "trigger_key", "status") ` +
        `VALUES ('brief', 1, 'schedule:brief:2026-09-28T06:00:00.000Z', 'completed')`,
      `INSERT INTO "notifications" ("workflow_run_id", "channel_id", "payload", "status") ` +
        `VALUES (1, 1, '{"text":"Done."}', 'delivered')`,
    ]) {
      await old.query(sql);
    }
    await old.destroy();

    const db = await open();
    for (const table of [
      'workflows',
      'triggers',
      'workflow_notification_targets',
      'allowed_chats',
    ]) {
      expect(await tables(db)).not.toContain(table);
    }
    expect(
      await db.query(
        `SELECT "id", "name", "agent_name", "max_attempts" FROM "legacy_workflows"`,
      ),
    ).toEqual([{ id: 1, name: 'brief', agent_name: 'coach', max_attempts: 2 }]);
    expect(
      await db.query(
        `SELECT "workflow_id", "config_json", "timezone" FROM "legacy_triggers"`,
      ),
    ).toEqual([
      {
        workflow_id: 1,
        config_json: '{"cron":"0 8 * * *"}',
        timezone: 'Europe/Berlin',
      },
    ]);
    expect(
      await db.query(`SELECT * FROM "legacy_workflow_notification_targets"`),
    ).toEqual([{ workflow_id: 1, channel_id: 1 }]);
    expect(
      await db.query(`SELECT "chat_key", "title" FROM "legacy_allowed_chats"`),
    ).toEqual([{ chat_key: '42', title: 'Owner' }]);
    // Runs keep everything but their Trigger, and their Notifications.
    const columns = await db.query<{ name: string }[]>(
      `SELECT "name" FROM pragma_table_info('workflow_runs')`,
    );
    expect(columns.map((column) => column.name)).not.toContain('trigger_id');
    expect(await db.getRepository(WorkflowRun).find()).toEqual([
      expect.objectContaining({
        id: 1,
        workflowName: 'brief',
        triggerKey: 'schedule:brief:2026-09-28T06:00:00.000Z',
        status: 'completed',
      }),
    ]);
    expect(await db.getRepository(Notification).count()).toBe(1);
    // Removing a Trigger no longer touches runs.
    await db.query(`DELETE FROM "legacy_triggers"`);
    expect(await db.getRepository(WorkflowRun).count()).toBe(1);
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('gives the Workflow tables and allowed chats back, and migrates again', async () => {
    const db = await open();
    const { workflow, trigger, run, channel } = await seed(db);

    await db.undoLastMigration({ transaction: 'each' });
    expect(await tables(db)).toEqual(
      expect.arrayContaining([
        'workflows',
        'triggers',
        'workflow_notification_targets',
        'allowed_chats',
      ]),
    );
    expect(await db.query(`SELECT "id", "name" FROM "workflows"`)).toEqual([
      { id: workflow.id, name: workflow.name },
    ]);
    expect(
      await db.query(`SELECT "id", "workflow_id" FROM "triggers"`),
    ).toEqual([{ id: trigger.id, workflow_id: workflow.id }]);
    expect(
      await db.query(`SELECT * FROM "workflow_notification_targets"`),
    ).toEqual([{ workflow_id: workflow.id, channel_id: channel.id }]);
    expect(await db.query(`SELECT "chat_key" FROM "allowed_chats"`)).toEqual([
      { chat_key: CHAT_ID },
    ]);
    // Runs get their Trigger column back, empty.
    expect(
      await db.query(`SELECT "id", "trigger_id" FROM "workflow_runs"`),
    ).toEqual([{ id: run.id, trigger_id: null }]);
    await rejectsWith(
      db.query(`UPDATE "workflow_runs" SET "trigger_id" = 999`),
      'SQLITE_CONSTRAINT_FOREIGNKEY',
    );
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);

    await db.runMigrations({ transaction: 'each' });
    expect(await workflowRow(db, workflow.id)).toMatchObject({
      name: workflow.name,
    });
    expect(
      await db.getRepository(WorkflowRun).findOneByOrFail({ id: run.id }),
    ).toMatchObject({ workflowName: workflow.name });
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('keeps every record across closing and reopening the database', async () => {
    let db = await open();
    await seed(db);
    const before = await readAll(db);
    await db.destroy();

    db = await open();

    expect(await readAll(db)).toEqual(before);
    expect(before.agents[0]).toMatchObject({
      title: 'Personal assistant',
      provider_options: '{"model":"claude-opus-5-5","effort":"high"}',
      use_shared_instructions: 1,
      codex_skip_git_repo_check: 0,
      tool_policy_json: '{"permissions":"bypass"}',
      enabled: 1,
    });
    expect(before.schedules[0]!.nextRunAt).toEqual(
      new Date('2026-09-28T06:00:00.000Z'),
    );
    expect(before.runs[0]).toMatchObject({
      attempt: 1,
      result: { text: 'Done.' },
    });
    expect(before.notifications[0]).toMatchObject({
      status: 'pending',
      attempt: 0,
    });
  });

  it('stores Telegram IDs as exact strings', async () => {
    const db = await open();
    await seed(db);

    const [channel] = await db.getRepository(Channel).find();
    expect(channel!.address).toEqual({ chatId: CHAT_ID, messageThreadId: '7' });
    const [update] = await db.getRepository(InboundUpdate).find();
    expect(update!.externalUpdateId).toBe(UPDATE_ID);
    expect(
      await db.query(
        `SELECT typeof("external_key") AS "key", ` +
          `typeof(json_extract("address_json", '$.chatId')) AS "chat" ` +
          `FROM "channels"`,
      ),
    ).toEqual([{ key: 'text', chat: 'text' }]);
    expect(
      await db.query(
        `SELECT typeof("external_update_id") AS "id" FROM "inbound_updates"`,
      ),
    ).toEqual([{ id: 'text' }]);
  });

  it('stores timestamps in UTC whatever the local time zone', async () => {
    vi.stubEnv('TZ', 'Asia/Tashkent');
    const instant = new Date('2026-03-29T01:30:00.000Z');
    expect(instant.getHours()).toBe(6);
    const db = await open();
    const seeded = await seed(db);
    const { schedule } = seeded;
    const repo = db.getRepository(ScheduleState);

    await repo.update(schedule.id, { nextRunAt: instant });

    expect(await db.query(`SELECT "next_run_at" FROM "schedules"`)).toEqual([
      { next_run_at: '2026-03-29 01:30:00.000' },
    ]);
    expect((await repo.findOneByOrFail({ id: schedule.id })).nextRunAt).toEqual(
      instant,
    );
    // SQLite's own datetime('now') default is UTC too.
    const channel = await db
      .getRepository(Channel)
      .findOneByOrFail({ id: seeded.channel.id });
    expect(Math.abs(channel.createdAt.getTime() - Date.now())).toBeLessThan(
      60_000,
    );
  });

  describe('unique constraints', () => {
    let db: DataSource;
    let seeded: Seeded;

    beforeEach(async () => {
      db = await open();
      seeded = await seed(db);
    });

    it('rejects a duplicate Agent or Workflow name', async () => {
      await rejectsWith(
        db.query(
          `INSERT INTO "legacy_agents" ("name", "provider", "provider_options", "tool_policy_json") ` +
            `VALUES ('assistant', 'codex', '{}', '{}')`,
        ),
        'SQLITE_CONSTRAINT_UNIQUE',
      );
      await rejectsWith(
        db.query(
          `INSERT INTO "legacy_workflows" ("name", "agent_name", "input_template") ` +
            `VALUES ('daily-brief', 'assistant', 'Again.')`,
        ),
        'SQLITE_CONSTRAINT_UNIQUE',
      );
    });

    it('rejects a second Channel with the same integration and key', async () => {
      await rejectsWith(
        db.getRepository(Channel).insert({
          integrationKind: 'telegram',
          externalKey: seeded.channel.externalKey,
          address: {},
        }),
        'SQLITE_CONSTRAINT_UNIQUE',
      );
    });

    it('allows each chat once per integration', async () => {
      await rejectsWith(
        db.query(
          `INSERT INTO "legacy_allowed_chats" ("integration_kind", "chat_key", "kind") ` +
            `VALUES ('telegram', ?, 'private')`,
          [CHAT_ID],
        ),
        'SQLITE_CONSTRAINT_UNIQUE',
      );
    });

    it('allows one run per Workflow and trigger key', async () => {
      const runs = db.getRepository(WorkflowRun);
      await rejectsWith(
        runs.insert({
          workflowName: seeded.workflow.name,
          triggerKey: seeded.run.triggerKey,
        }),
        'SQLITE_CONSTRAINT_UNIQUE',
      );

      await runs.insert({
        workflowName: 'weekly-review',
        triggerKey: seeded.run.triggerKey,
      });
    });

    it('rejects a duplicate inbound update', async () => {
      await rejectsWith(
        db.getRepository(InboundUpdate).insert({
          integrationKind: 'telegram',
          externalUpdateId: UPDATE_ID,
        }),
        'SQLITE_CONSTRAINT_PRIMARYKEY',
      );
    });

    it('allows one active Session per Channel and Agent', async () => {
      const sessions = db.getRepository(Session);
      const next = {
        agentName: seeded.agent.name,
        channelId: seeded.channel.id,
        provider: 'codex' as const,
        workingDirectory: '/home/owner/code',
      };
      await rejectsWith(sessions.insert(next), 'SQLITE_CONSTRAINT_UNIQUE');

      await sessions.update(seeded.session.id, { status: 'closed' });
      await sessions.insert(next);
      expect(await sessions.countBy({ status: 'active' })).toBe(1);
    });

    it('records a delivered Notification in history once', async () => {
      const messages = db.getRepository(Message);
      const delivered = (externalMessageId: string) => ({
        channelId: seeded.channel.id,
        direction: 'out' as const,
        origin: 'workflow' as const,
        externalMessageId,
        text: 'Done.',
        notificationId: seeded.notification.id,
      });
      await messages.insert(delivered('12'));
      await rejectsWith(
        messages.insert(delivered('13')),
        'SQLITE_CONSTRAINT_UNIQUE',
      );
    });

    it('allows one Notification and one target per Workflow and Channel', async () => {
      await rejectsWith(
        db.getRepository(Notification).insert({
          workflowRunId: seeded.run.id,
          channelId: seeded.channel.id,
          payload: {},
        }),
        'SQLITE_CONSTRAINT_UNIQUE',
      );
      await rejectsWith(
        db.query(
          `INSERT INTO "legacy_workflow_notification_targets" ("workflow_id", "channel_id") ` +
            `VALUES (?, ?)`,
          [seeded.workflow.id, seeded.channel.id],
        ),
        'SQLITE_CONSTRAINT_PRIMARYKEY',
      );
    });
  });

  describe('foreign keys', () => {
    let db: DataSource;
    let seeded: Seeded;

    beforeEach(async () => {
      db = await open();
      seeded = await seed(db);
    });

    const MISSING = 999;
    const orphans: [string, (s: Seeded) => string][] = [
      [
        'legacy_channel_agents.channel_id',
        () =>
          `INSERT INTO "legacy_channel_agents" ("channel_id", "agent_name") ` +
          `VALUES (${MISSING}, 'main')`,
      ],
      [
        'settings.main_agent_id',
        () => `UPDATE "legacy_settings" SET "main_agent_id" = ${MISSING}`,
      ],
      [
        'sessions.channel_id',
        (s) =>
          `INSERT INTO "sessions" ("agent_name", "channel_id", "provider", ` +
          `"working_directory") VALUES ('${s.agent.name}', ${MISSING}, 'claude', '/x')`,
      ],
      [
        'legacy_triggers.workflow_id',
        () =>
          `INSERT INTO "legacy_triggers" ("workflow_id", "kind", "config_json") ` +
          `VALUES (${MISSING}, 'manual', '{}')`,
      ],
      [
        'legacy_workflow_notification_targets.workflow_id',
        (s) =>
          `INSERT INTO "legacy_workflow_notification_targets" ("workflow_id", ` +
          `"channel_id") VALUES (${MISSING}, ${s.channel.id})`,
      ],
      [
        'legacy_workflow_notification_targets.channel_id',
        (s) =>
          `INSERT INTO "legacy_workflow_notification_targets" ("workflow_id", ` +
          `"channel_id") VALUES (${s.workflow.id}, ${MISSING})`,
      ],
      [
        'notifications.workflow_run_id',
        (s) =>
          `INSERT INTO "notifications" ("workflow_run_id", "channel_id", ` +
          `"payload") VALUES (${MISSING}, ${s.channel.id}, '{}')`,
      ],
      [
        'messages.channel_id',
        () =>
          `INSERT INTO "messages" ("channel_id", "direction", "origin", ` +
          `"external_message_id", "text") VALUES (${MISSING}, 'out', 'pero', '1', 'x')`,
      ],
      [
        'messages.session_id',
        (s) =>
          `INSERT INTO "messages" ("channel_id", "session_id", "direction", ` +
          `"origin", "external_message_id", "text") ` +
          `VALUES (${s.channel.id}, ${MISSING}, 'in', 'user', '1', 'x')`,
      ],
      [
        'messages.notification_id',
        (s) =>
          `INSERT INTO "messages" ("channel_id", "direction", "origin", ` +
          `"external_message_id", "text", "notification_id") ` +
          `VALUES (${s.channel.id}, 'out', 'workflow', '1', 'x', ${MISSING})`,
      ],
      [
        'notifications.channel_id',
        (s) =>
          `INSERT INTO "notifications" ("workflow_run_id", "channel_id", ` +
          `"payload") VALUES (${s.run.id}, ${MISSING}, '{}')`,
      ],
    ];

    it.each(orphans)('rejects an orphan %s', async (_, sql) => {
      await rejectsWith(db.query(sql(seeded)), 'SQLITE_CONSTRAINT_FOREIGNKEY');
    });

    it('keeps Agents and Channels that history refers to', async () => {
      // SQLite reports ON DELETE RESTRICT as SQLITE_CONSTRAINT_TRIGGER.
      const restricted = /FOREIGN KEY constraint failed/;
      await expect(
        db.getRepository(Session).delete(seeded.session.id),
      ).rejects.toThrow(restricted);
      await expect(
        db.query(`DELETE FROM "legacy_agents" WHERE "id" = ?`, [
          seeded.agent.id,
        ]),
      ).rejects.toThrow(restricted);
      await expect(
        db.getRepository(Channel).delete(seeded.channel.id),
      ).rejects.toThrow(restricted);
    });

    it('keeps the runs of a Workflow that is gone, by its name', async () => {
      await db.query(`DELETE FROM "legacy_workflows"`);

      expect(
        await db
          .getRepository(WorkflowRun)
          .findOneByOrFail({ id: seeded.run.id }),
      ).toMatchObject({ workflowName: 'daily-brief' });
      expect(await db.getRepository(Notification).count()).toBe(1);
    });

    it('lets state name Agents and Workflows that no row holds', async () => {
      await db.getRepository(Session).update(seeded.session.id, {
        agentName: 'gone',
      });
      await db.getRepository(Message).update(seeded.message.id, {
        agentName: 'gone',
      });
      await db.getRepository(WorkflowRun).update(seeded.run.id, {
        workflowName: 'gone',
      });
      await db.query(`UPDATE "legacy_workflows" SET "agent_name" = 'gone'`);
      expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
    });

    it('removes the rows a run or Workflow owns along with it', async () => {
      await db.getRepository(WorkflowRun).delete(seeded.run.id);
      expect(await db.getRepository(Notification).count()).toBe(0);

      await db.query(`DELETE FROM "legacy_workflows"`);
      expect(await count(db, 'legacy_triggers')).toBe(0);
      expect(await count(db, 'legacy_workflow_notification_targets')).toBe(0);
      expect(await db.getRepository(Channel).count()).toBe(1);
    });
  });

  describe('checks', () => {
    let db: DataSource;

    beforeEach(async () => {
      db = await open();
      await seed(db);
    });

    it.each([
      `UPDATE "legacy_agents" SET "provider" = 'gpt'`,
      `UPDATE "legacy_agents" SET "tool_policy_json" = '['`,
      `UPDATE "channels" SET "integration_kind" = 'slack'`,
      `UPDATE "legacy_allowed_chats" SET "integration_kind" = 'slack'`,
      `UPDATE "legacy_allowed_chats" SET "kind" = 'channel'`,
      `UPDATE "sessions" SET "status" = 'paused'`,
      `UPDATE "sessions" SET "provider" = 'gpt'`,
      `UPDATE "legacy_workflows" SET "concurrency_policy" = 'parallel'`,
      `UPDATE "legacy_triggers" SET "kind" = 'webhook'`,
      `UPDATE "workflow_runs" SET "status" = 'done'`,
      `UPDATE "workflow_runs" SET "attempt" = 0`,
      `UPDATE "workflow_runs" SET "result_json" = '{'`,
      `UPDATE "notifications" SET "status" = 'sent'`,
      `UPDATE "inbound_updates" SET "status" = 'ignored'`,
      `UPDATE "legacy_settings" SET "history_carryover" = -1`,
      `UPDATE "legacy_settings" SET "default_permissions" = 'always'`,
      `UPDATE "messages" SET "direction" = 'sideways'`,
      // A Workflow's message is its delivered Notification, and only that.
      `UPDATE "messages" SET "origin" = 'workflow', "agent_name" = NULL, "session_id" = NULL`,
      `UPDATE "messages" SET "notification_id" = (SELECT "id" FROM "notifications")`,
      // People write in; Agents, Pero, and Workflows write out.
      `UPDATE "messages" SET "direction" = 'in'`,
      `UPDATE "messages" SET "origin" = 'user'`,
      // An Agent's reply names its Agent and Session.
      `UPDATE "messages" SET "session_id" = NULL`,
      `UPDATE "messages" SET "agent_name" = NULL`,
    ])('rejects %s', async (sql) => {
      await rejectsWith(db.query(sql), 'SQLITE_CONSTRAINT_CHECK');
    });

    it.each([
      'Assistant',
      'daily brief',
      'daily_brief',
      '-daily',
      'daily-',
      'daily--brief',
      '',
      'a'.repeat(65),
    ])('rejects the non-slug name %j', async (name) => {
      for (const table of ['legacy_agents', 'legacy_workflows']) {
        await rejectsWith(
          db.query(`UPDATE "${table}" SET "name" = ?`, [name]),
          'SQLITE_CONSTRAINT_CHECK',
        );
      }
      await db.query(`UPDATE "legacy_agents" SET "name" = ?`, ['a'.repeat(64)]);
    });
  });
});
