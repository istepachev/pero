import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataSourceToken } from '@nestjs/typeorm';
import Database from 'better-sqlite3';
import type { Chat, User } from 'grammy/types';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from '../src/common/errors.js';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import {
  type ControlClient,
  createControlClient,
} from '../src/control/client.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';
import { AgentManager } from '../src/agents/agent-manager.js';
import { AgentRuntimes } from '../src/runtimes/agent-runtimes.js';
import type { FakeAgentRuntime } from '../src/runtimes/testing/fake-agent-runtime.js';
import { FakeBotApi } from '../src/telegram/testing/fake-bot-api.js';
import {
  NOT_ALLOWED,
  NotificationDelivery,
} from '../src/notifications/notification-delivery.js';
import type { RunView } from '../src/control/protocol.js';
import { Notification } from '../src/persistence/entities/notification.entity.js';
import { WorkflowRun } from '../src/persistence/entities/workflow-run.entity.js';
import { Agent } from '../src/persistence/entities/agent.entity.js';
import { Channel } from '../src/persistence/entities/channel.entity.js';

const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';

const FORUM: Chat.SupergroupChat = {
  id: -1001234567890,
  type: 'supergroup',
  title: 'Household',
  is_forum: true,
};
const OWNER: User = { id: 1234, is_bot: false, first_name: 'Ada' };

describe('Workflow and Trigger definitions (e2e)', () => {
  let tmp: string;
  let vault: string;
  let dataDir: string;
  let client: ControlClient;
  let daemon: Daemon | undefined;
  let api: FakeBotApi;

  beforeEach(async () => {
    api = new FakeBotApi();
    await api.listen();
    // Short: macOS limits socket paths to 104 bytes.
    tmp = mkdtempSync(join(tmpdir(), 'pero-'));
    dataDir = join(tmp, 'pero');
    vault = join(tmp, 'vault');
    mkdirSync(vault);
    client = createControlClient(join(dataDir, 'run', 'pero.sock'));
  });

  afterEach(async () => {
    await daemon?.stop('test finished');
    daemon = undefined;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function start() {
    daemon = await startDaemon({
      config: resolveBootstrapConfig({ dataDir, env: {} }),
      foreground: false,
      // Telegram is the fake Bot API and Agents echo: nothing real runs.
      env: { PERO_TELEGRAM_API_ROOT: api.url, PERO_FAKE_RUNTIME: 'echo' },
    });
  }

  async function restart() {
    await daemon!.stop('restart');
    daemon = undefined;
    await start();
  }

  /** The echo runtime Claude Agents use in the running daemon. */
  function claude(): FakeAgentRuntime {
    return daemon!.app.get(AgentRuntimes).get('claude') as FakeAgentRuntime;
  }

  /** An enabled Agent `coach` and Workflow `brief` that can be run by hand. */
  async function manualBrief(maxAttempts?: number) {
    await client.call('settings.update', { defaultWorkingDirectory: vault });
    await client.call('agents.create', { name: 'coach' });
    await client.call('workflows.create', {
      name: 'brief',
      agent: 'coach',
      inputTemplate: 'Summarize the day.',
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
    });
    await client.call('triggers.add', { workflow: 'brief', kind: 'manual' });
  }

  /** Every text the bot has sent. */
  const texts = () => api.sent().map((payload) => String(payload.text));

  /**
   * Starts Pero with `brief` connected to the fake Bot API, and onboards the
   * English topic of the allowed forum, which `brief` notifies. `say`
   * writes there as the owner.
   */
  async function englishTopic() {
    let nextMessageId = 1;
    const say = (text: string) =>
      api.push({
        message: {
          message_id: nextMessageId++,
          date: 0,
          chat: FORUM,
          from: OWNER,
          text,
          message_thread_id: 7,
          is_topic_message: true,
        } as never,
      });
    api.chats.set(String(FORUM.id), FORUM);
    await start();
    await manualBrief();
    await client.call('settings.update', { telegramBotToken: TOKEN });
    await vi.waitFor(async () =>
      expect((await client.call('telegram.chats')).bot).toBe('pero_test_bot'),
    );
    await client.call('telegram.allow', { chatId: String(FORUM.id) });
    // The topic onboards its Agent, which answers.
    say('Hello');
    await vi.waitFor(() => expect(texts()).toContain('echo: Hello'));
    const channel = (await client.call('channels.list')).channels.find(
      ({ key }) => key === `${FORUM.id}:7`,
    )!;
    await client.call('workflows.notify', {
      name: 'brief',
      channel: channel.id,
      notify: true,
    });
    return { channel, say, texts };
  }

  /** Runs `brief` by hand and waits until it has finished. */
  async function runBrief(): Promise<RunView> {
    const { id } = await client.call('workflows.run', { name: 'brief' });
    return waitFinished(id);
  }

  async function waitFinished(id: number): Promise<RunView> {
    let run: RunView | undefined;
    await vi.waitFor(async () => {
      run = await client.call('runs.get', { id });
      expect(['pending', 'running']).not.toContain(run.status);
    });
    return run!;
  }

  it('creates, edits, disables, and enables Workflows and their Triggers, keeping them across a restart', async () => {
    await start();
    await client.call('settings.update', {
      defaultWorkingDirectory: vault,
      timezone: 'Europe/Berlin',
    });
    await client.call('agents.create', { name: 'coach' });
    await client.call('agents.create', { name: 'editor' });

    const created = await client.call('workflows.create', {
      name: 'Evening-Review',
      agent: 'coach',
      inputTemplate: "Review today's chats.",
    });
    expect(created).toMatchObject({
      name: 'evening-review',
      title: null,
      agent: 'coach',
      enabled: true,
      triggers: [],
    });

    const edited = await client.call('workflows.edit', {
      name: 'evening-review',
      change: { title: 'Evening review', agent: 'editor' },
    });
    expect(edited).toMatchObject({ title: 'Evening review', agent: 'editor' });

    const daily = await client.call('triggers.add', {
      workflow: 'evening-review',
      kind: 'schedule',
      cron: '0 21 * * *',
    });
    expect(daily).toMatchObject({
      workflow: 'evening-review',
      kind: 'schedule',
      cron: '0 21 * * *',
      timezone: 'Europe/Berlin',
      enabled: true,
    });
    // 21:00 in Berlin, within the next day.
    const nextRun = new Date(daily.nextRunAt!);
    expect(nextRun.getTime()).toBeGreaterThan(Date.now());
    expect(nextRun.getTime() - Date.now()).toBeLessThanOrEqual(
      24 * 60 * 60 * 1000,
    );
    expect(
      nextRun.toLocaleTimeString('en-GB', { timeZone: 'Europe/Berlin' }),
    ).toBe('21:00:00');
    const manual = await client.call('triggers.add', {
      workflow: 'evening-review',
      kind: 'manual',
    });
    const weekly = await client.call('triggers.add', {
      workflow: 'evening-review',
      kind: 'schedule',
      cron: '@weekly',
      timezone: 'UTC',
    });

    expect(
      await client.call('triggers.setEnabled', {
        id: daily.id,
        enabled: false,
      }),
    ).toMatchObject({ id: daily.id, enabled: false, nextRunAt: null });
    expect(await client.call('triggers.remove', { id: weekly.id })).toEqual(
      weekly,
    );
    expect(
      await client.call('workflows.edit', {
        name: 'evening-review',
        change: { enabled: false },
      }),
    ).toMatchObject({ enabled: false });

    await restart();

    const { workflows } = await client.call('workflows.list');
    expect(workflows).toEqual([
      expect.objectContaining({
        name: 'evening-review',
        title: 'Evening review',
        agent: 'editor',
        inputTemplate: "Review today's chats.",
        enabled: false,
        triggerCount: 2,
      }),
    ]);
    expect(
      (await client.call('workflows.get', { name: 'evening-review' })).triggers,
    ).toEqual([{ ...daily, enabled: false, nextRunAt: null }, manual]);
    expect(
      (await client.call('triggers.list', { workflow: 'evening-review' }))
        .triggers,
    ).toEqual([{ ...daily, enabled: false, nextRunAt: null }, manual]);

    await client.call('workflows.edit', {
      name: 'evening-review',
      change: { enabled: true },
    });
    await client.call('triggers.setEnabled', { id: daily.id, enabled: true });
    expect(
      await client.call('workflows.get', { name: 'evening-review' }),
    ).toMatchObject({
      enabled: true,
      triggers: [
        { id: daily.id, enabled: true, nextRunAt: expect.any(String) },
        { id: manual.id },
      ],
    });
  });

  it('rejects invalid references and definitions', async () => {
    await start();
    await client.call('settings.update', { defaultWorkingDirectory: vault });
    await client.call('agents.create', { name: 'coach' });
    await client.call('agents.create', { name: 'idle' });
    await client.call('agents.edit', {
      name: 'idle',
      change: { enabled: false },
    });

    await expect(
      client.call('workflows.create', {
        name: 'review',
        agent: 'nobody',
        inputTemplate: 'Go',
      }),
    ).rejects.toThrow(new NotFoundError('No Agent named nobody'));
    await expect(
      client.call('workflows.create', {
        name: 'review',
        agent: 'idle',
        inputTemplate: 'Go',
      }),
    ).rejects.toThrow(
      new InvalidInputError(
        'Agent idle is disabled; enable it first with pero agents enable idle',
      ),
    );
    await expect(
      client.call('workflows.create', {
        name: 'review',
        agent: 'coach',
        inputTemplate: '  ',
      }),
    ).rejects.toThrow(
      new InvalidInputError('inputTemplate: must not be empty'),
    );

    await client.call('workflows.create', {
      name: 'review',
      agent: 'coach',
      inputTemplate: 'Go',
    });
    await expect(
      client.call('workflows.create', {
        name: 'review',
        agent: 'coach',
        inputTemplate: 'Go',
      }),
    ).rejects.toThrow(
      new ConflictError('A Workflow named review already exists'),
    );
    await expect(
      client.call('workflows.edit', {
        name: 'review',
        change: { agent: 'idle' },
      }),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      client.call('workflows.edit', { name: 'nothing', change: {} }),
    ).rejects.toThrow(new NotFoundError('No Workflow named nothing'));

    await expect(
      client.call('triggers.add', { workflow: 'nothing', kind: 'manual' }),
    ).rejects.toThrow(new NotFoundError('No Workflow named nothing'));
    await expect(
      client.call('triggers.add', {
        workflow: 'review',
        kind: 'schedule',
        cron: '0 9 * *',
      }),
    ).rejects.toThrow(/^cron: must be a cron expression of five fields/);
    await expect(
      client.call('triggers.add', {
        workflow: 'review',
        kind: 'schedule',
        cron: '0 9 * * *',
        timezone: 'Mars/Olympus',
      }),
    ).rejects.toThrow(
      new InvalidInputError(
        'timezone: must be an IANA time zone such as Europe/Berlin',
      ),
    );
    await expect(client.call('triggers.remove', { id: 99 })).rejects.toThrow(
      new NotFoundError('No Trigger with ID 99'),
    );
    await expect(
      client.call('triggers.setEnabled', { id: 99, enabled: false }),
    ).rejects.toThrow(NotFoundError);

    expect((await client.call('triggers.list', {})).triggers).toEqual([]);
    expect(
      (await client.call('workflows.list')).workflows.map(({ name }) => name),
    ).toEqual(['review']);
  });

  it('runs a Workflow by hand through its manual Trigger, away from every Channel', async () => {
    await start();
    await client.call('settings.update', { defaultWorkingDirectory: vault });
    await client.call('agents.create', { name: 'coach' });
    await client.call('workflows.create', {
      name: 'brief',
      agent: 'coach',
      inputTemplate: 'Summarize the day.',
    });

    await expect(
      client.call('workflows.run', { name: 'brief' }),
    ).rejects.toThrow(
      new InvalidInputError(
        'Workflow brief has no manual Trigger; add one with pero triggers add brief --manual',
      ),
    );
    await expect(
      client.call('workflows.run', { name: 'nothing' }),
    ).rejects.toThrow(new NotFoundError('No Workflow named nothing'));
    await expect(client.call('runs.get', { id: 99 })).rejects.toThrow(
      new NotFoundError('No run with ID 99'),
    );

    const trigger = await client.call('triggers.add', {
      workflow: 'brief',
      kind: 'manual',
    });
    const queued = await client.call('workflows.run', { name: 'brief' });
    expect(queued).toMatchObject({
      workflow: 'brief',
      triggerId: trigger.id,
      attempt: 1,
    });
    await vi.waitFor(async () => {
      expect(await client.call('runs.get', { id: queued.id })).toMatchObject({
        status: 'completed',
        result: 'echo: Summarize the day.',
        error: null,
      });
    });
    const [listed] = (await client.call('triggers.list', { workflow: 'brief' }))
      .triggers;
    expect(listed!.lastRunAt).not.toBeNull();
    // No Channel took part.
    expect((await client.call('channels.list')).channels).toEqual([]);

    await restart();
    expect(await client.call('runs.get', { id: queued.id })).toMatchObject({
      status: 'completed',
      result: 'echo: Summarize the day.',
    });
  });

  it('keeps the history input a Workflow reads, and completes a run with none to read without its Agent', async () => {
    await start();
    await client.call('settings.update', { defaultWorkingDirectory: vault });
    await client.call('agents.create', { name: 'coach' });
    await client.call('workflows.create', {
      name: 'english',
      agent: 'coach',
      inputTemplate: 'Suggest improvements:\n{{history}}',
      history: { messages: 'people' },
    });
    await client.call('triggers.add', { workflow: 'english', kind: 'manual' });
    await expect(
      client.call('workflows.edit', {
        name: 'english',
        change: { history: { channels: [42] } },
      }),
    ).rejects.toThrow(
      new InvalidInputError(
        'history.channels: no Channel with ID 42; pero channels ls lists them',
      ),
    );

    const queued = await client.call('workflows.run', { name: 'english' });
    await vi.waitFor(async () => {
      expect(await client.call('runs.get', { id: queued.id })).toMatchObject({
        status: 'completed',
        skipped: true,
        result: null,
      });
    });
    expect(claude().requests).toHaveLength(0);

    await restart();
    expect(
      (await client.call('workflows.get', { name: 'english' })).history,
    ).toEqual({
      channels: 'all',
      messages: 'people',
      hours: null,
      runWhenEmpty: false,
    });
    await client.call('workflows.edit', {
      name: 'english',
      change: { history: { runWhenEmpty: true } },
    });
    const ran = await client.call('workflows.run', { name: 'english' });
    await vi.waitFor(async () => {
      expect(await client.call('runs.get', { id: ran.id })).toMatchObject({
        status: 'completed',
        skipped: false,
        result: 'echo: Suggest improvements:\n[No messages in this window]',
      });
    });

    await client.call('workflows.edit', {
      name: 'english',
      change: { history: null },
    });
    expect(
      (await client.call('workflows.get', { name: 'english' })).history,
    ).toBeNull();
  });

  it('starts one catch-up run for the times a schedule missed while Pero was down', async () => {
    const HOUR_MS = 60 * 60 * 1000;
    await start();
    await client.call('settings.update', { defaultWorkingDirectory: vault });
    await client.call('agents.create', { name: 'coach' });
    await client.call('workflows.create', {
      name: 'hourly',
      agent: 'coach',
      inputTemplate: 'Check the inbox.',
    });
    const trigger = await client.call('triggers.add', {
      workflow: 'hourly',
      kind: 'schedule',
      cron: '0 * * * *',
      timezone: 'UTC',
    });

    // Down since the top of the hour three hours ago.
    await daemon!.stop('downtime');
    daemon = undefined;
    const lastHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const due = new Date(lastHour - 3 * HOUR_MS);
    const db = new Database(join(dataDir, 'pero.sqlite'));
    db.prepare(`UPDATE "triggers" SET "next_run_at" = ? WHERE "id" = ?`).run(
      due.toISOString().replace('T', ' ').replace('Z', ''),
      trigger.id,
    );
    db.close();

    await start();
    await vi.waitFor(async () => {
      expect(await client.call('runs.get', { id: 1 })).toMatchObject({
        workflow: 'hourly',
        triggerId: trigger.id,
        triggerKey: `schedule:${trigger.id}:${due.toISOString()}`,
        // The three hours since; the first missed time is the run itself.
        skippedCount: 3,
        status: 'completed',
        result: 'echo: Check the inbox.',
      });
    });
    const [listed] = (
      await client.call('triggers.list', { workflow: 'hourly' })
    ).triggers;
    expect(listed!.nextRunAt).toBe(new Date(lastHour + HOUR_MS).toISOString());
    expect(listed!.lastRunAt).not.toBeNull();

    await restart();
    await expect(client.call('runs.get', { id: 2 })).rejects.toThrow(
      new NotFoundError('No run with ID 2'),
    );
  });

  it('records a run Pero stopped as interrupted on the next start, and retries it as its Workflow allows', async () => {
    await start();
    await manualBrief(2);
    const held = claude().hold();
    const queued = await client.call('workflows.run', { name: 'brief' });
    const request = await held.started;

    // Stop with a short shutdown timeout, so the run is aborted mid-way.
    await daemon!.app.get(AgentManager).drain(10);
    expect(request.signal.aborted).toBe(true);
    await restart();

    await vi.waitFor(async () => {
      expect(
        await client.call('runs.get', { id: queued.id + 1 }),
      ).toMatchObject({
        workflow: 'brief',
        triggerId: queued.triggerId,
        triggerKey: `retry:${queued.id}`,
        attempt: 2,
        status: 'completed',
        result: 'echo: Summarize the day.',
      });
    });
    expect(await client.call('runs.get', { id: queued.id })).toMatchObject({
      status: 'interrupted',
      attempt: 1,
      result: null,
      error: `Pero stopped before the run finished; run ${queued.id + 1} retries it (attempt 2 of 2)`,
    });
    expect(
      (await client.call('workflows.get', { name: 'brief' })).maxAttempts,
    ).toBe(2);
  });

  it('cancels a run waiting to start at once, and a running one through its runtime', async () => {
    await start();
    await manualBrief();
    await client.call('settings.update', { maxConcurrentRuns: 1 });
    await client.call('workflows.create', {
      name: 'other',
      agent: 'coach',
      inputTemplate: 'Something else.',
    });
    await client.call('triggers.add', { workflow: 'other', kind: 'manual' });
    const held = claude().hold();
    const running = await client.call('workflows.run', { name: 'brief' });
    const request = await held.started;
    const waiting = await client.call('workflows.run', { name: 'other' });

    expect(await client.call('runs.cancel', { id: waiting.id })).toMatchObject({
      status: 'cancelled',
      startedAt: null,
      error: 'Cancelled with pero runs cancel',
    });
    expect(await client.call('runs.cancel', { id: running.id })).toMatchObject({
      status: 'running',
    });
    await vi.waitFor(async () => {
      expect(await client.call('runs.get', { id: running.id })).toMatchObject({
        status: 'cancelled',
        result: null,
        error: 'Cancelled with pero runs cancel',
      });
    });
    expect(request.signal.aborted).toBe(true);
    // The cancelled run never started.
    expect(claude().requests).toHaveLength(1);
    await expect(
      client.call('runs.cancel', { id: running.id }),
    ).rejects.toThrow(
      new ConflictError(`Run ${running.id} has already finished (cancelled)`),
    );

    await restart();
    expect(await client.call('runs.get', { id: running.id })).toMatchObject({
      status: 'cancelled',
    });
  });

  it('notifies the Channels a Workflow names of each finished run, keeping the Notifications across a restart', async () => {
    await start();
    await manualBrief();
    const dataSource = daemon!.app.get<DataSource>(getDataSourceToken());
    const coach = await dataSource
      .getRepository(Agent)
      .findOneByOrFail({ name: 'coach' });
    const channels = dataSource.getRepository(Channel);
    const { id: channel } = await channels.save(
      channels.create({
        integrationKind: 'telegram',
        externalKey: '-1001234567890:7',
        address: { chatId: '-1001234567890', topicId: '7' },
        title: 'English',
        agentId: coach.id,
      }),
    );

    expect(
      await client.call('workflows.notify', {
        name: 'brief',
        channel,
        notify: true,
      }),
    ).toMatchObject({
      changed: true,
      workflow: {
        targets: [
          {
            id: channel,
            integrationKind: 'telegram',
            key: '-1001234567890:7',
            title: 'English',
            enabled: true,
          },
        ],
      },
    });
    expect(
      (
        await client.call('workflows.notify', {
          name: 'brief',
          channel,
          notify: true,
        })
      ).changed,
    ).toBe(false);
    await expect(
      client.call('workflows.notify', {
        name: 'brief',
        channel: 42,
        notify: true,
      }),
    ).rejects.toThrow(
      new NotFoundError('No Channel with ID 42; pero channels ls lists them'),
    );

    const queued = await client.call('workflows.run', { name: 'brief' });
    await vi.waitFor(async () => {
      expect(await client.call('runs.get', { id: queued.id })).toMatchObject({
        status: 'completed',
      });
    });

    await restart();
    const db = new Database(join(dataDir, 'pero.sqlite'), { readonly: true });
    try {
      expect(
        db
          .prepare(
            'SELECT workflow_run_id, channel_id, payload FROM notifications',
          )
          .all(),
      ).toEqual([
        {
          workflow_run_id: queued.id,
          channel_id: channel,
          payload: JSON.stringify({
            text: 'Workflow brief\n\necho: Summarize the day.',
          }),
        },
      ]);
    } finally {
      db.close();
    }
    expect(
      (await client.call('workflows.get', { name: 'brief' })).targets,
    ).toHaveLength(1);

    expect(
      await client.call('workflows.notify', {
        name: 'brief',
        channel,
        notify: false,
      }),
    ).toMatchObject({ changed: true, workflow: { targets: [] } });
  });

  it(
    'delivers a Notification once Telegram is back, where the next turn receives it',
    { timeout: 60_000 },
    async () => {
      const { channel, say, texts } = await englishTopic();
      const delivery = daemon!.app.get(NotificationDelivery);
      const notification = () =>
        daemon!.app
          .get<DataSource>(getDataSourceToken())
          .getRepository(Notification)
          .findOneByOrFail({ channelId: channel.id });

      api.down();
      const queued = await client.call('workflows.run', { name: 'brief' });
      await vi.waitFor(async () => {
        expect(await client.call('runs.get', { id: queued.id })).toMatchObject({
          status: 'completed',
        });
      });
      await delivery.tick(new Date(Date.now() + 1_000));
      expect(await notification()).toMatchObject({
        status: 'pending',
        providerMessageId: null,
        lastError: expect.stringMatching(/^Telegram is unreachable: /),
      });
      expect((await notification()).attempt).toBeGreaterThanOrEqual(1);

      api.up();
      await delivery.tick(new Date(Date.now() + 24 * 60 * 60_000));
      expect(await notification()).toMatchObject({
        status: 'delivered',
        lastError: null,
      });
      const suggestion = 'Workflow brief\n\necho: Summarize the day.';
      expect(
        api.sent().filter((payload) => payload.text === suggestion),
      ).toEqual([expect.objectContaining({ message_thread_id: 7 })]);
      expect(
        await daemon!.app
          .get<DataSource>(getDataSourceToken())
          .getRepository(WorkflowRun)
          .count(),
      ).toBe(1);
      const { messages } = await client.call('channels.history', {
        id: channel.id,
      });
      expect(
        messages.filter((message) => message.origin === 'workflow'),
      ).toEqual([
        expect.objectContaining({
          direction: 'out',
          workflow: 'brief',
          agent: null,
          text: suggestion,
        }),
      ]);

      // Telegram polls again after a pause; the next message there gets it.
      say('Tell me more');
      await vi.waitFor(() => expect(texts().at(-1)).toMatch(/Tell me more$/), {
        timeout: 30_000,
      });
      const reply = texts().at(-1)!;
      expect(reply).toMatch(
        /^echo: \[Posted in this chat by Workflows since the last message here\]\n/,
      );
      expect(reply).toContain(`Workflow brief: ${suggestion}`);

      say('Thanks');
      await vi.waitFor(() => expect(texts().at(-1)).toBe('echo: Thanks'));
    },
  );
  it(
    'lists, shows, and retries runs and Notifications by hand',
    { timeout: 60_000 },
    async () => {
      const { channel } = await englishTopic();
      const delivery = daemon!.app.get(NotificationDelivery);
      const runs = () =>
        daemon!.app
          .get<DataSource>(getDataSourceToken())
          .getRepository(WorkflowRun);

      // A run that fails is retried by hand, however few attempts it has.
      claude().failNext();
      const failed = await runBrief();
      expect(failed).toMatchObject({
        status: 'failed',
        error: 'The model is overloaded',
      });
      expect(
        await client.call('runs.list', { status: 'failed' }),
      ).toMatchObject({ runs: [{ id: failed.id, workflow: 'brief' }] });
      const { run: queued, alsoReadBy } = await client.call('runs.retry', {
        id: failed.id,
      });
      expect(queued).toMatchObject({
        status: 'pending',
        attempt: 2,
        triggerKey: `retry:${failed.id}`,
      });
      expect(alsoReadBy).toBeNull();
      expect(await waitFinished(queued.id)).toMatchObject({
        status: 'completed',
        result: 'echo: Summarize the day.',
      });
      expect(await client.call('runs.get', { id: failed.id })).toMatchObject({
        status: 'failed',
        retriedBy: queued.id,
      });
      await expect(
        client.call('runs.retry', { id: failed.id }),
      ).rejects.toThrow(ConflictError);
      expect(
        (await client.call('runs.list', {})).runs.map(({ id }) => id),
      ).toEqual([queued.id, failed.id]);

      // A Notification to a chat no longer allowed fails, and is delivered
      // once retried after the chat is allowed again.
      await delivery.tick(new Date(Date.now() + 1_000));
      expect(
        (await client.call('runs.get', { id: queued.id })).notifications,
      ).toEqual([expect.objectContaining({ status: 'delivered' })]);
      await client.call('telegram.deny', { chatId: String(FORUM.id) });
      const denied = await runBrief();
      await delivery.tick(new Date(Date.now() + 1_000));
      const [notification] = (
        await client.call('notifications.list', { status: 'failed' })
      ).notifications;
      expect(notification).toMatchObject({
        runId: denied.id,
        workflow: 'brief',
        channel: { id: channel.id, key: `${FORUM.id}:7` },
        status: 'failed',
        attempt: 1,
        lastError: NOT_ALLOWED,
      });
      expect(
        await client.call('notifications.get', { id: notification!.id }),
      ).toMatchObject({
        chatAllowed: false,
        delivering: false,
        text: 'Workflow brief\n\necho: Summarize the day.',
      });
      const sentBefore = api.sent().length;

      await client.call('telegram.allow', { chatId: String(FORUM.id) });
      expect(
        await client.call('notifications.retry', { id: notification!.id }),
      ).toMatchObject({ status: 'pending', attempt: 0, chatAllowed: true });
      await vi.waitFor(async () =>
        expect(
          await client.call('notifications.get', { id: notification!.id }),
        ).toMatchObject({
          status: 'delivered',
          attempt: 1,
          lastError: null,
          providerMessageId: expect.any(String),
        }),
      );
      expect(api.sent().slice(sentBefore)).toEqual([
        expect.objectContaining({
          text: 'Workflow brief\n\necho: Summarize the day.',
          message_thread_id: 7,
        }),
      ]);
      await expect(
        client.call('notifications.retry', { id: notification!.id }),
      ).rejects.toThrow(ConflictError);
      await expect(
        client.call('notifications.get', { id: 99 }),
      ).rejects.toThrow(NotFoundError);
      const { messages } = await client.call('channels.history', {
        id: channel.id,
        limit: 50,
      });
      // Why the first run failed, its retry's answer, and the answer
      // delivered by hand, each once.
      expect(
        messages
          .filter((message) => message.origin === 'workflow')
          .map(({ text }) => text),
      ).toEqual([
        `Run ${failed.id} of Workflow brief failed: The model is overloaded`,
        'Workflow brief\n\necho: Summarize the day.',
        'Workflow brief\n\necho: Summarize the day.',
      ]);
      // No run was created for a delivery.
      expect(await runs().count()).toBe(3);
    },
  );

  it(
    'deletes history older than the retention setting',
    { timeout: 60_000 },
    async () => {
      const { channel, say } = await englishTopic();
      say('Recent');
      await vi.waitFor(() => expect(texts()).toContain('echo: Recent'));
      const history = async () =>
        (
          await client.call('channels.history', { id: channel.id, limit: 50 })
        ).messages.map(({ text }) => text);
      expect(await history()).toEqual([
        expect.stringContaining('Agent'),
        'Hello',
        'echo: Hello',
        'Recent',
        'echo: Recent',
      ]);
      // The welcome and the first exchange were forty days ago.
      await daemon!.app
        .get<DataSource>(getDataSourceToken())
        .query(
          `UPDATE "messages" SET "created_at" = datetime('now', '-40 days') WHERE "text" NOT LIKE '%Recent'`,
        );

      expect(
        await client.call('settings.update', { historyRetentionDays: 30 }),
      ).toMatchObject({ historyRetentionDays: 30 });
      await restart();

      await vi.waitFor(async () =>
        expect(await history()).toEqual(['Recent', 'echo: Recent']),
      );
      expect(
        await client.call('channels.get', { id: channel.id }),
      ).toMatchObject({ messages: 2 });
      await client.call('settings.update', { historyRetentionDays: null });
      expect(
        (await client.call('settings.get')).historyRetentionDays,
      ).toBeNull();
    },
  );
});
