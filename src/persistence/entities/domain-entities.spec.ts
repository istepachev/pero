import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataSourceOptions } from '../data-source-options.js';
import { openDatabase } from '../open-database.js';
import { Agent } from './agent.entity.js';
import { AllowedChat } from './allowed-chat.entity.js';
import { Channel } from './channel.entity.js';
import { InboundUpdate } from './inbound-update.entity.js';
import { Message } from './message.entity.js';
import { Notification } from './notification.entity.js';
import { Session } from './session.entity.js';
import { Settings } from './settings.entity.js';
import { Trigger } from './trigger.entity.js';
import { WorkflowNotificationTarget } from './workflow-notification-target.entity.js';
import { WorkflowRun } from './workflow-run.entity.js';
import { Workflow } from './workflow.entity.js';

const DOMAIN_TABLES = [
  'agents',
  'allowed_chats',
  'channels',
  'inbound_updates',
  'messages',
  'notifications',
  'sessions',
  'triggers',
  'workflow_notification_targets',
  'workflow_runs',
  'workflows',
];

// Beyond Number.MAX_SAFE_INTEGER, so a numeric round trip would change them.
const CHAT_ID = '-1009007199254740993';
const UPDATE_ID = '9007199254740993';

type Seeded = Awaited<ReturnType<typeof seed>>;

/** One row in every domain table, linked the way the runtime links them. */
async function seed(ds: DataSource) {
  const agent = await ds.getRepository(Agent).save({
    name: 'assistant',
    title: 'Personal assistant',
    provider: 'claude',
    instructions: 'Be brief.',
    providerOptions: { model: 'claude-opus-5-5', effort: 'high' },
    workingDirectory: null,
    toolPolicy: { allow: ['Read'] },
  });
  const channel = await ds.getRepository(Channel).save({
    integrationKind: 'telegram',
    externalKey: `${CHAT_ID}:7`,
    address: { chatId: CHAT_ID, messageThreadId: '7' },
    title: 'Groceries',
    agentId: agent.id,
  });
  const session = await ds.getRepository(Session).save({
    agentId: agent.id,
    channelId: channel.id,
    providerSessionId: 'provider-session',
    provider: agent.provider,
    workingDirectory: '/home/owner/vault',
  });
  const workflow = await ds.getRepository(Workflow).save({
    name: 'daily-brief',
    title: null,
    agentId: agent.id,
    inputTemplate: 'Summarize today.',
  });
  const trigger = await ds.getRepository(Trigger).save({
    workflowId: workflow.id,
    kind: 'schedule',
    config: { cron: '0 8 * * *' },
    timezone: 'Europe/Berlin',
    nextRunAt: new Date('2026-09-28T06:00:00.000Z'),
    lastRunAt: null,
  });
  const run = await ds.getRepository(WorkflowRun).save({
    workflowId: workflow.id,
    triggerId: trigger.id,
    triggerKey: 'schedule:2026-09-27T06:00:00Z',
    status: 'completed',
    executionConfig: { provider: 'claude', workingDirectory: '/vault' },
    startedAt: new Date('2026-09-27T06:00:01.000Z'),
    finishedAt: new Date('2026-09-27T06:02:00.000Z'),
    result: { text: 'Done.' },
    errorText: null,
  });
  const target = await ds.getRepository(WorkflowNotificationTarget).save({
    workflowId: workflow.id,
    channelId: channel.id,
  });
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
  const allowedChat = await ds.getRepository(AllowedChat).save({
    integrationKind: 'telegram',
    chatKey: CHAT_ID,
    kind: 'group',
    title: 'Household',
  });
  const message = await ds.getRepository(Message).save({
    channelId: channel.id,
    agentId: agent.id,
    sessionId: session.id,
    direction: 'out',
    origin: 'agent',
    externalMessageId: '9007199254740995',
    senderId: null,
    text: 'Added milk.',
  });
  await ds.getRepository(Settings).update(1, { mainAgentId: agent.id });
  return {
    agent,
    message,
    allowedChat,
    channel,
    session,
    workflow,
    trigger,
    run,
    target,
    notification,
    update,
  };
}

/** Every domain row, read back through the entities. */
async function readAll(ds: DataSource) {
  return {
    settings: await ds.getRepository(Settings).find(),
    agents: await ds.getRepository(Agent).find(),
    allowedChats: await ds.getRepository(AllowedChat).find(),
    channels: await ds.getRepository(Channel).find(),
    sessions: await ds.getRepository(Session).find(),
    workflows: await ds.getRepository(Workflow).find(),
    triggers: await ds.getRepository(Trigger).find(),
    runs: await ds.getRepository(WorkflowRun).find(),
    targets: await ds.getRepository(WorkflowNotificationTarget).find(),
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

    // Message history, the allowlist, the Session resume migration, then
    // the domain tables.
    for (let i = 0; i < 4; i++) {
      await db.undoLastMigration({ transaction: 'each' });
    }
    expect(await tables(db)).toEqual([
      'migrations',
      'settings',
      'sqlite_sequence',
    ]);
    expect(await db.getRepository(Settings).count()).toBe(1);

    await db.runMigrations({ transaction: 'each' });
    expect(await tables(db)).toEqual(expect.arrayContaining(DOMAIN_TABLES));
    await seed(db);
  });

  it("gives existing Sessions their Agent's provider and folder, and reverts to config versions", async () => {
    const db = await open();
    await db
      .getRepository(Settings)
      .update(1, { defaultWorkingDirectory: '/home/owner/vault' });
    const seeded = await seed(db);

    // Message history, the allowlist, then the Session resume migration.
    for (let i = 0; i < 3; i++) {
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
    await db.getRepository(Settings).update(1, {
      defaultWorkingDirectory: '/home/owner/vault',
      sharedInstructions: 'Be kind.',
    });
    await seed(db);

    // Message history, then the allowlist.
    await db.undoLastMigration({ transaction: 'each' });
    await db.undoLastMigration({ transaction: 'each' });
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
    expect(
      await db.getRepository(Settings).findOneByOrFail({ id: 1 }),
    ).toMatchObject({
      defaultWorkingDirectory: '/home/owner/vault',
      sharedInstructions: 'Be kind.',
      mainAgentId: null,
    });
    expect(await db.getRepository(Channel).find()).toEqual([
      expect.objectContaining({ title: null }),
    ]);
    expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('keeps the settings row through the message history migration and back', async () => {
    const db = await open();
    const { agent } = await seed(db);
    await db.getRepository(Settings).update(1, {
      sharedInstructions: 'Be kind.',
      historyCarryover: 10,
    });

    await db.undoLastMigration({ transaction: 'each' });
    expect(await tables(db)).not.toContain('messages');
    expect(
      await db.query(
        `SELECT "shared_instructions", "main_agent_id" FROM "settings"`,
      ),
    ).toEqual([{ shared_instructions: 'Be kind.', main_agent_id: agent.id }]);

    await db.runMigrations({ transaction: 'each' });
    expect(
      await db.getRepository(Settings).findOneByOrFail({ id: 1 }),
    ).toMatchObject({
      sharedInstructions: 'Be kind.',
      mainAgentId: agent.id,
      historyCarryover: 50,
    });
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
      providerOptions: { model: 'claude-opus-5-5', effort: 'high' },
      useSharedInstructions: true,
      codexSkipGitRepoCheck: false,
      toolPolicy: { allow: ['Read'] },
      enabled: true,
    });
    expect(before.triggers[0]!.nextRunAt).toEqual(
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
    const { trigger } = await seed(db);
    const repo = db.getRepository(Trigger);

    await repo.update(trigger.id, { nextRunAt: instant });

    expect(await db.query(`SELECT "next_run_at" FROM "triggers"`)).toEqual([
      { next_run_at: '2026-03-29 01:30:00.000' },
    ]);
    expect((await repo.findOneByOrFail({ id: trigger.id })).nextRunAt).toEqual(
      instant,
    );
    // SQLite's own datetime('now') default is UTC too.
    const [agent] = await db.getRepository(Agent).find();
    expect(Math.abs(agent!.createdAt.getTime() - Date.now())).toBeLessThan(
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
        db.getRepository(Agent).insert({
          name: 'assistant',
          provider: 'codex',
          providerOptions: { model: null, effort: null },
          toolPolicy: {},
        }),
        'SQLITE_CONSTRAINT_UNIQUE',
      );
      await rejectsWith(
        db.getRepository(Workflow).insert({
          name: 'daily-brief',
          agentId: seeded.agent.id,
          inputTemplate: 'Again.',
        }),
        'SQLITE_CONSTRAINT_UNIQUE',
      );
    });

    it('rejects a second Channel with the same integration and key', async () => {
      await rejectsWith(
        db.getRepository(Channel).insert({
          integrationKind: 'telegram',
          externalKey: seeded.channel.externalKey,
          address: {},
          agentId: seeded.agent.id,
        }),
        'SQLITE_CONSTRAINT_UNIQUE',
      );
    });

    it('allows each chat once per integration', async () => {
      await rejectsWith(
        db.getRepository(AllowedChat).insert({
          integrationKind: 'telegram',
          chatKey: seeded.allowedChat.chatKey,
          kind: 'private',
        }),
        'SQLITE_CONSTRAINT_UNIQUE',
      );
    });

    it('allows one run per Workflow and trigger key', async () => {
      const runs = db.getRepository(WorkflowRun);
      await rejectsWith(
        runs.insert({
          workflowId: seeded.workflow.id,
          triggerKey: seeded.run.triggerKey,
        }),
        'SQLITE_CONSTRAINT_UNIQUE',
      );

      const other = await db.getRepository(Workflow).save({
        name: 'weekly-review',
        agentId: seeded.agent.id,
        inputTemplate: 'Review the week.',
      });
      await runs.insert({
        workflowId: other.id,
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
        agentId: seeded.agent.id,
        channelId: seeded.channel.id,
        provider: 'codex' as const,
        workingDirectory: '/home/owner/code',
      };
      await rejectsWith(sessions.insert(next), 'SQLITE_CONSTRAINT_UNIQUE');

      await sessions.update(seeded.session.id, { status: 'closed' });
      await sessions.insert(next);
      expect(await sessions.countBy({ status: 'active' })).toBe(1);
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
        db.getRepository(WorkflowNotificationTarget).insert({
          workflowId: seeded.workflow.id,
          channelId: seeded.channel.id,
        }),
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
        'channels.agent_id',
        () =>
          `INSERT INTO "channels" ("integration_kind", "external_key", ` +
          `"address_json", "agent_id") VALUES ('telegram', 'x', '{}', ${MISSING})`,
      ],
      [
        'settings.main_agent_id',
        () => `UPDATE "settings" SET "main_agent_id" = ${MISSING}`,
      ],
      [
        'sessions.agent_id',
        (s) =>
          `INSERT INTO "sessions" ("agent_id", "channel_id", "provider", ` +
          `"working_directory") VALUES (${MISSING}, ${s.channel.id}, 'claude', '/x')`,
      ],
      [
        'sessions.channel_id',
        (s) =>
          `INSERT INTO "sessions" ("agent_id", "channel_id", "provider", ` +
          `"working_directory") VALUES (${s.agent.id}, ${MISSING}, 'claude', '/x')`,
      ],
      [
        'workflows.agent_id',
        () =>
          `INSERT INTO "workflows" ("name", "agent_id", "input_template") ` +
          `VALUES ('x', ${MISSING}, 'x')`,
      ],
      [
        'triggers.workflow_id',
        () =>
          `INSERT INTO "triggers" ("workflow_id", "kind", "config_json") ` +
          `VALUES (${MISSING}, 'manual', '{}')`,
      ],
      [
        'workflow_runs.workflow_id',
        () =>
          `INSERT INTO "workflow_runs" ("workflow_id", "trigger_key") ` +
          `VALUES (${MISSING}, 'x')`,
      ],
      [
        'workflow_runs.trigger_id',
        (s) =>
          `INSERT INTO "workflow_runs" ("workflow_id", "trigger_id", ` +
          `"trigger_key") VALUES (${s.workflow.id}, ${MISSING}, 'x')`,
      ],
      [
        'workflow_notification_targets.workflow_id',
        (s) =>
          `INSERT INTO "workflow_notification_targets" ("workflow_id", ` +
          `"channel_id") VALUES (${MISSING}, ${s.channel.id})`,
      ],
      [
        'workflow_notification_targets.channel_id',
        (s) =>
          `INSERT INTO "workflow_notification_targets" ("workflow_id", ` +
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
        'messages.agent_id',
        (s) =>
          `INSERT INTO "messages" ("channel_id", "agent_id", "direction", ` +
          `"origin", "external_message_id", "text") ` +
          `VALUES (${s.channel.id}, ${MISSING}, 'in', 'user', '1', 'x')`,
      ],
      [
        'messages.session_id',
        (s) =>
          `INSERT INTO "messages" ("channel_id", "session_id", "direction", ` +
          `"origin", "external_message_id", "text") ` +
          `VALUES (${s.channel.id}, ${MISSING}, 'in', 'user', '1', 'x')`,
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

    it('keeps Agents, Channels, and Workflows that history refers to', async () => {
      // SQLite reports ON DELETE RESTRICT as SQLITE_CONSTRAINT_TRIGGER.
      const restricted = /FOREIGN KEY constraint failed/;
      await expect(
        db.getRepository(Session).delete(seeded.session.id),
      ).rejects.toThrow(restricted);
      await expect(
        db.getRepository(Agent).delete(seeded.agent.id),
      ).rejects.toThrow(restricted);
      await expect(
        db.getRepository(Channel).delete(seeded.channel.id),
      ).rejects.toThrow(restricted);
      await expect(
        db.getRepository(Workflow).delete(seeded.workflow.id),
      ).rejects.toThrow(restricted);
    });

    it('keeps a run when its Trigger is removed', async () => {
      await db.getRepository(Trigger).delete(seeded.trigger.id);

      const run = await db
        .getRepository(WorkflowRun)
        .findOneByOrFail({ id: seeded.run.id });
      expect(run.triggerId).toBeNull();
    });

    it('removes the rows a run or Workflow owns along with it', async () => {
      await db.getRepository(WorkflowRun).delete(seeded.run.id);
      expect(await db.getRepository(Notification).count()).toBe(0);

      await db.getRepository(Workflow).delete(seeded.workflow.id);
      expect(await db.getRepository(Trigger).count()).toBe(0);
      expect(await db.getRepository(WorkflowNotificationTarget).count()).toBe(
        0,
      );
      expect(await db.getRepository(Channel).count()).toBe(1);
    });
  });

  describe('checks', () => {
    let db: DataSource;
    let seeded: Seeded;

    beforeEach(async () => {
      db = await open();
      seeded = await seed(db);
    });

    it.each([
      `UPDATE "agents" SET "provider" = 'gpt'`,
      `UPDATE "agents" SET "tool_policy_json" = '['`,
      `UPDATE "channels" SET "integration_kind" = 'slack'`,
      `UPDATE "allowed_chats" SET "integration_kind" = 'slack'`,
      `UPDATE "allowed_chats" SET "kind" = 'channel'`,
      `UPDATE "sessions" SET "status" = 'paused'`,
      `UPDATE "sessions" SET "provider" = 'gpt'`,
      `UPDATE "workflows" SET "concurrency_policy" = 'parallel'`,
      `UPDATE "triggers" SET "kind" = 'webhook'`,
      `UPDATE "workflow_runs" SET "status" = 'done'`,
      `UPDATE "workflow_runs" SET "attempt" = 0`,
      `UPDATE "workflow_runs" SET "result_json" = '{'`,
      `UPDATE "notifications" SET "status" = 'sent'`,
      `UPDATE "inbound_updates" SET "status" = 'ignored'`,
      `UPDATE "settings" SET "history_carryover" = -1`,
      `UPDATE "messages" SET "direction" = 'sideways'`,
      `UPDATE "messages" SET "origin" = 'workflow'`,
      // People write in; Agents and Pero write out.
      `UPDATE "messages" SET "direction" = 'in'`,
      `UPDATE "messages" SET "origin" = 'user'`,
      // An Agent's reply names its Agent and Session.
      `UPDATE "messages" SET "session_id" = NULL`,
      `UPDATE "messages" SET "agent_id" = NULL`,
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
      for (const table of ['agents', 'workflows']) {
        await rejectsWith(
          db.query(`UPDATE "${table}" SET "name" = ?`, [name]),
          'SQLITE_CONSTRAINT_CHECK',
        );
      }
      await db.query(`UPDATE "agents" SET "name" = ?`, ['a'.repeat(64)]);
    });

    it('validates Agent provider options on write and read', async () => {
      const repo = db.getRepository(Agent);

      await expect(
        repo.update(seeded.agent.id, {
          providerOptions: { model: null, effort: 'extreme' as 'high' },
        }),
      ).rejects.toThrow(/effort/);

      await db.query(
        `UPDATE "agents" SET "provider_options" = '{"temperature":1}'`,
      );
      await expect(
        repo.findOneByOrFail({ id: seeded.agent.id }),
      ).rejects.toThrow(/temperature/);
    });
  });
});
