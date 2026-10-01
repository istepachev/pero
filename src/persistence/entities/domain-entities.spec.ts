import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleFingerprint } from '../../scheduler/schedule.js';
import { dataSourceOptions } from '../data-source-options.js';
import { openDatabase } from '../open-database.js';
import { Channel } from './channel.entity.js';
import { InboundUpdate } from './inbound-update.entity.js';
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

// Beyond Number.MAX_SAFE_INTEGER, so a numeric round trip would change them.
const CHAT_ID = '-1009007199254740993';
const UPDATE_ID = '9007199254740993';

type Seeded = Awaited<ReturnType<typeof seed>>;

/** One row in every table, linked the way the runtime links them. */
async function seed(ds: DataSource) {
  const agent = 'assistant';
  const workflow = 'daily-brief';
  const channel = await ds.getRepository(Channel).save({
    integrationKind: 'telegram',
    externalKey: `${CHAT_ID}:7`,
    address: { chatId: CHAT_ID, messageThreadId: '7' },
    title: 'Groceries',
  });
  const session = await ds.getRepository(Session).save({
    agentName: agent,
    channelId: channel.id,
    providerSessionId: 'provider-session',
    provider: 'claude',
    workingDirectory: '/home/owner/vault',
  });
  const schedule = await ds.getRepository(ScheduleState).save({
    workflowName: workflow,
    fingerprint: scheduleFingerprint({
      cron: '0 8 * * *',
      timezone: 'Europe/Berlin',
    }),
    nextRunAt: new Date('2026-09-28T06:00:00.000Z'),
    lastRunAt: new Date('2026-09-27T06:00:00.000Z'),
  });
  const run = await ds.getRepository(WorkflowRun).save({
    workflowName: workflow,
    triggerKey: 'schedule:2026-09-27T06:00:00Z',
    status: 'completed',
    executionConfig: { provider: 'claude', workingDirectory: '/vault' },
    startedAt: new Date('2026-09-27T06:00:01.000Z'),
    finishedAt: new Date('2026-09-27T06:02:00.000Z'),
    result: { text: 'Done.' },
    errorText: null,
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
  const message = await ds.getRepository(Message).save({
    channelId: channel.id,
    agentName: agent,
    sessionId: session.id,
    direction: 'out',
    origin: 'agent',
    externalMessageId: '9007199254740995',
    senderId: null,
    text: 'Added milk.',
  });
  return {
    agent,
    workflow,
    message,
    channel,
    session,
    schedule,
    run,
    notification,
    update,
  };
}

/** Every row, read back through the entities. */
async function readAll(ds: DataSource) {
  return {
    channels: await ds.getRepository(Channel).find(),
    sessions: await ds.getRepository(Session).find(),
    schedules: await ds.getRepository(ScheduleState).find(),
    runs: await ds.getRepository(WorkflowRun).find(),
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

  it('holds only state', async () => {
    const db = await open();
    expect(
      (await tables(db)).filter(
        (table) => !['migrations', 'sqlite_sequence'].includes(table),
      ),
    ).toEqual(STATE_TABLES);
  });

  it('keeps every record across closing and reopening the database', async () => {
    let db = await open();
    await seed(db);
    const before = await readAll(db);
    await db.destroy();

    db = await open();

    expect(await readAll(db)).toEqual(before);
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

    it('allows one schedule row per Workflow', async () => {
      const schedules = db.getRepository(ScheduleState);
      await rejectsWith(
        schedules.insert({
          workflowName: seeded.workflow,
          fingerprint: scheduleFingerprint({
            cron: '0 9 * * *',
            timezone: 'Europe/Berlin',
          }),
        }),
        'SQLITE_CONSTRAINT_UNIQUE',
      );

      await schedules.insert({
        workflowName: 'weekly-review',
        fingerprint: seeded.schedule.fingerprint,
      });
    });

    it('allows one run per Workflow and trigger key', async () => {
      const runs = db.getRepository(WorkflowRun);
      await rejectsWith(
        runs.insert({
          workflowName: seeded.workflow,
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
        agentName: seeded.agent,
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

    it('allows one Notification per run and Channel', async () => {
      await rejectsWith(
        db.getRepository(Notification).insert({
          workflowRunId: seeded.run.id,
          channelId: seeded.channel.id,
          payload: {},
        }),
        'SQLITE_CONSTRAINT_UNIQUE',
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
        'sessions.channel_id',
        (s) =>
          `INSERT INTO "sessions" ("agent_name", "channel_id", "provider", ` +
          `"working_directory") VALUES ('${s.agent}', ${MISSING}, 'claude', '/x')`,
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

    it('keeps the Channels and Sessions that history refers to', async () => {
      // SQLite reports ON DELETE RESTRICT as SQLITE_CONSTRAINT_TRIGGER.
      const restricted = /FOREIGN KEY constraint failed/;
      await expect(
        db.getRepository(Session).delete(seeded.session.id),
      ).rejects.toThrow(restricted);
      await expect(
        db.getRepository(Channel).delete(seeded.channel.id),
      ).rejects.toThrow(restricted);
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
      expect(await db.query(`PRAGMA foreign_key_check`)).toEqual([]);
    });

    it('removes the Notifications of a run along with it', async () => {
      await db.getRepository(WorkflowRun).delete(seeded.run.id);
      expect(await db.getRepository(Notification).count()).toBe(0);
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
      `UPDATE "channels" SET "integration_kind" = 'slack'`,
      `UPDATE "channels" SET "address_json" = '{'`,
      `UPDATE "sessions" SET "status" = 'paused'`,
      `UPDATE "sessions" SET "provider" = 'gpt'`,
      `UPDATE "workflow_runs" SET "status" = 'done'`,
      `UPDATE "workflow_runs" SET "attempt" = 0`,
      `UPDATE "workflow_runs" SET "result_json" = '{'`,
      `UPDATE "notifications" SET "status" = 'sent'`,
      `UPDATE "notifications" SET "attempt" = -1`,
      `UPDATE "inbound_updates" SET "status" = 'ignored'`,
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
  });
});
