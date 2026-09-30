import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsService } from '../agents/agents.service.js';
import { InvalidInputError } from '../common/errors.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Message } from '../persistence/entities/message.entity.js';
import { Notification } from '../persistence/entities/notification.entity.js';
import { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AGENT_RUNTIMES } from '../runtimes/agent-runtimes.js';
import { FakeAgentRuntime } from '../runtimes/testing/fake-agent-runtime.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { HistoryRetention, RETENTION_BATCH_SIZE } from './history-retention.js';
import { HistoryRetentionModule } from './history-retention.module.js';

const DAY_MS = 24 * 60 * 60_000;
const NOW = new Date('2026-09-29T12:00:00Z');

describe('HistoryRetention', () => {
  let tmp: string;
  let vault: string;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let retention: HistoryRetention;
  let settings: SettingsService;
  let channelId: number;

  async function boot(): Promise<void> {
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: join(tmp, 'pero.sqlite') }),
        SettingsModule,
        WorkflowsModule,
        HistoryRetentionModule,
      ],
    })
      .overrideProvider(AGENT_RUNTIMES)
      .useValue([new FakeAgentRuntime('claude'), new FakeAgentRuntime('codex')])
      .compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    retention = moduleRef.get(HistoryRetention);
    settings = moduleRef.get(SettingsService);
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-retention-'));
    vault = join(tmp, 'vault');
    mkdirSync(vault);
    await boot();
    await settings.update({ defaultWorkingDirectory: vault });
    const agent = await moduleRef.get(AgentsService).create({ name: 'coach' });
    const channels = ds.getRepository(Channel);
    channelId = (
      await channels.save(
        channels.create({
          integrationKind: 'telegram',
          externalKey: '1234',
          address: { chatId: '1234' },
          title: null,
          agentId: agent.id,
        }),
      )
    ).id;
  });

  afterEach(async () => {
    await moduleRef.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Records a person's message `text`, sent `daysAgo` days before NOW. */
  async function message(text: string, daysAgo: number): Promise<number> {
    const { identifiers } = await ds.getRepository(Message).insert({
      channelId,
      agentName: null,
      sessionId: null,
      direction: 'in',
      origin: 'user',
      externalMessageId: text,
      senderId: '1234',
      text,
    });
    const { id } = identifiers[0] as { id: number };
    await sentAt(id, daysAgo);
    return id;
  }

  /** Dates message `id` `daysAgo` days before NOW, as SQLite stores it. */
  async function sentAt(id: number, daysAgo: number): Promise<void> {
    const at = new Date(NOW.getTime() - daysAgo * DAY_MS);
    await ds.query(`UPDATE "messages" SET "created_at" = ? WHERE "id" = ?`, [
      at.toISOString().slice(0, 19).replace('T', ' '),
      id,
    ]);
  }

  async function texts(): Promise<string[]> {
    const messages = await ds
      .getRepository(Message)
      .find({ order: { id: 'ASC' } });
    return messages.map(({ text }) => text);
  }

  it('keeps every message while the setting is unset', async () => {
    await message('Last year', 365);
    await message('Today', 0);

    expect(await retention.prune(NOW)).toBe(0);
    expect(await texts()).toEqual(['Last year', 'Today']);
  });

  it('deletes the messages older than the setting, and only those', async () => {
    await message('Forty days ago', 40);
    await message('Thirty-one days ago', 31);
    await message('Twenty-nine days ago', 29);
    await message('Today', 0);
    await settings.update({ historyRetentionDays: 30 });

    expect(await retention.prune(NOW)).toBe(2);
    expect(await texts()).toEqual(['Twenty-nine days ago', 'Today']);
    expect(await retention.prune(NOW)).toBe(0);
  });

  it("deletes a delivered Notification's message, keeping the Notification and its run", async () => {
    await moduleRef.get(WorkflowsService).create({
      name: 'brief',
      agent: 'coach',
      inputTemplate: 'Go.',
    });
    const run = await ds.getRepository(WorkflowRun).save({
      workflowName: 'brief',
      triggerId: null,
      triggerKey: 'manual:old',
      status: 'completed',
      attempt: 1,
      result: { text: 'Old answer' },
    });
    const notification = await ds.getRepository(Notification).save({
      workflowRunId: run.id,
      channelId,
      status: 'delivered',
      payload: { text: 'Old answer' },
      attempt: 1,
      nextAttemptAt: null,
      providerMessageId: '7',
    });
    const { identifiers } = await ds.getRepository(Message).insert({
      channelId,
      agentName: null,
      sessionId: null,
      direction: 'out',
      origin: 'workflow',
      externalMessageId: '7',
      senderId: null,
      text: 'Old answer',
      notificationId: notification.id,
    });
    await sentAt((identifiers[0] as { id: number }).id, 10);
    await settings.update({ historyRetentionDays: 7 });

    expect(await retention.prune(NOW)).toBe(1);
    expect(await texts()).toEqual([]);
    expect(
      await ds.getRepository(Notification).findOneByOrFail({
        id: notification.id,
      }),
    ).toMatchObject({ status: 'delivered', payload: { text: 'Old answer' } });
    expect(
      await ds.getRepository(WorkflowRun).findOneByOrFail({ id: run.id }),
    ).toMatchObject({ result: { text: 'Old answer' } });
  });

  it('deletes in batches until none is left', async () => {
    const count = RETENTION_BATCH_SIZE * 2 + 5;
    const rows = Array.from({ length: count }, (_, index) => ({
      channelId,
      agentName: null,
      sessionId: null,
      direction: 'in' as const,
      origin: 'user' as const,
      externalMessageId: String(index),
      senderId: '1234',
      text: `Old ${index}`,
    }));
    for (let start = 0; start < rows.length; start += 500) {
      await ds.getRepository(Message).insert(rows.slice(start, start + 500));
    }
    await ds.query(
      `UPDATE "messages" SET "created_at" = '2026-01-01 00:00:00'`,
    );
    await message('Today', 0);
    await settings.update({ historyRetentionDays: 1 });

    expect(await retention.prune(NOW)).toBe(count);
    expect(await texts()).toEqual(['Today']);
  });

  it('deletes older messages when Pero starts', async () => {
    await message('Long ago', 400);
    await message('Now', 0);
    await settings.update({ historyRetentionDays: 30 });

    await moduleRef.close();
    await boot();

    await vi.waitFor(async () => expect(await texts()).toEqual(['Now']));
  });

  it('refuses a retention that is not a whole number of days from 1', async () => {
    for (const days of [0, -1, 1.5, 36_501]) {
      await expect(
        settings.update({ historyRetentionDays: days }),
      ).rejects.toThrow(InvalidInputError);
    }
    await settings.update({ historyRetentionDays: 36_500 });
    await settings.update({ historyRetentionDays: null });
    expect((await settings.get()).historyRetentionDays).toBeNull();
  });
});
