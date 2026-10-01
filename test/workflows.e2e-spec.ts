import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getDataSourceToken } from '@nestjs/typeorm';
import Database from 'better-sqlite3';
import type { Chat, User } from 'grammy/types';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError } from '../src/common/errors.js';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import { initWorkspace } from '../src/config/workspace-skeleton.js';
import {
  type ControlClient,
  createControlClient,
} from '../src/control/client.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';
import { AgentManager } from '../src/agents/agent-manager.js';
import { AgentRuntimes } from '../src/runtimes/agent-runtimes.js';
import type { FakeAgentRuntime } from '../src/runtimes/testing/fake-agent-runtime.js';
import { SettingsNotes } from '../src/settings/settings-notes.service.js';
import { FakeBotApi } from '../src/telegram/testing/fake-bot-api.js';
import {
  NOT_ALLOWED,
  NotificationDelivery,
} from '../src/notifications/notification-delivery.js';
import type { RunView } from '../src/control/protocol.js';
import { Notification } from '../src/persistence/entities/notification.entity.js';
import { WorkflowRun } from '../src/persistence/entities/workflow-run.entity.js';
import { Channel } from '../src/persistence/entities/channel.entity.js';
import { HostConfigService } from '../src/host-config/host-config.service.js';
import { ScheduleTick } from '../src/scheduler/schedule-tick.js';
import { BrokenNoteReports } from '../src/notifications/broken-note-reports.js';

const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';

const FORUM: Chat.SupergroupChat = {
  id: -1001234567890,
  type: 'supergroup',
  title: 'Household',
  is_forum: true,
};
const OWNER: User = { id: 1234, is_bot: false, first_name: 'Ada' };

describe('Workflows from notes (e2e)', () => {
  let tmp: string;
  let workspace: string;
  let database: string;
  let client: ControlClient;
  let daemon: Daemon | undefined;
  let api: FakeBotApi;
  /** Each edit gets a later modification time, whatever the clock. */
  let clock: number;

  beforeEach(async () => {
    api = new FakeBotApi();
    await api.listen();
    // Short: macOS limits socket paths to 104 bytes.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-')));
    workspace = join(tmp, 'ws');
    initWorkspace(workspace, tmp);
    database = join(workspace, '.pero', 'pero.sqlite');
    clock = Date.parse('2026-01-01T00:00:00Z');
    await pero();
    write('Agents/Coach.md', 'You coach.');
    client = createControlClient(join(workspace, '.pero', 'run', 'pero.sock'));
  });

  afterEach(async () => {
    await daemon?.stop('test finished');
    daemon = undefined;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Writes `text` to the note at `file` in the settings folder. */
  function write(file: string, text: string) {
    const path = join(workspace, 'data', 'Settings', file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    clock += 1_000;
    utimesSync(path, new Date(clock), new Date(clock));
  }

  /** Writes the note at `file`, read at once when Pero runs. */
  async function note(file: string, text: string) {
    write(file, text);
    await daemon?.app.get(SettingsNotes).refresh();
  }

  /**
   * Writes `Pero.md` with `properties`; a topic no note claims goes to the
   * main Agent. Read at once when Pero runs.
   */
  async function pero(properties: string[] = []) {
    await note(
      'Pero.md',
      ['---', 'new-topics: main-agent', ...properties, '---', ''].join('\n'),
    );
  }

  /**
   * Writes the Workflow note `Workflows/<title>.md` with `properties` and
   * `body`, read at once when Pero runs.
   */
  async function workflow(title: string, properties: string[], body: string) {
    await note(
      `Workflows/${title}.md`,
      ['---', ...properties, '---', body, ''].join('\n'),
    );
  }

  async function start() {
    daemon = await startDaemon({
      config: resolveBootstrapConfig({ workspace, env: {} }),
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

  /**
   * The Workflow `brief` of Agent `coach`, run by hand, with the other
   * `properties` of its note.
   */
  async function manualBrief(properties: string[] = []) {
    await workflow(
      'Brief',
      ['agent: coach', ...properties],
      'Summarize the day.',
    );
  }

  /** What run `brief` posts: the Workflow's title over the echoed input. */
  const SUMMARY = 'Brief\n\necho: Summarize the day.';

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
    await client.call('telegram.token', { token: TOKEN });
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
    // Telegram named no title, so the note names the topic by its ID.
    await manualBrief([`channel: ${channel.id}`]);
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

  it('serves Workflows from their notes, with each edit applying, across a restart', async () => {
    await pero(['timezone: Europe/Berlin']);
    write('Agents/Editor.md', 'You edit.');
    await start();

    await workflow(
      'Evening review',
      ['hour: 21', 'agent: coach'],
      "Review today's chats.",
    );
    const listed = (await client.call('workflows.list')).workflows;
    expect(listed).toEqual([
      expect.objectContaining({
        name: 'evening-review',
        title: 'Evening review',
        file: 'data/Settings/Workflows/Evening review.md',
        agent: 'coach',
        agentEnabled: true,
        inputTemplate: "Review today's chats.",
        enabled: true,
        channels: [],
        errors: [],
      }),
    ]);
    expect(listed[0]!.schedule).toMatchObject({
      cron: '0 21 * * *',
      timezone: 'Europe/Berlin',
      lastRunAt: null,
    });
    // 21:00 in Berlin, within the next day, once the scheduler saw it.
    await daemon!.app.get(ScheduleTick).tick();
    const { schedule } = await client.call('workflows.get', {
      name: 'evening-review',
    });
    const nextRun = new Date(schedule!.nextRunAt!);
    expect(nextRun.getTime()).toBeGreaterThan(Date.now());
    expect(nextRun.getTime() - Date.now()).toBeLessThanOrEqual(
      24 * 60 * 60 * 1000,
    );
    expect(
      nextRun.toLocaleTimeString('en-GB', { timeZone: 'Europe/Berlin' }),
    ).toBe('21:00:00');

    await workflow(
      'Evening review',
      ['hour: 22', 'agent: editor', 'enabled: false'],
      "Review today's chats, briefly.",
    );
    await restart();

    expect(
      await client.call('workflows.get', { name: 'Evening-Review' }),
    ).toMatchObject({
      agent: 'editor',
      inputTemplate: "Review today's chats, briefly.",
      enabled: false,
      // Kept, but never due while it is disabled.
      schedule: { cron: '0 22 * * *', nextRunAt: null },
    });
    await expect(
      client.call('workflows.get', { name: 'nothing' }),
    ).rejects.toThrow(new NotFoundError('No Workflow named nothing'));
  });

  it('reports a Workflow note naming a topic Pero has not seen, in status and check', async () => {
    await start();
    await workflow('Report', ['channel: Helth'], 'Report.');

    await expect(
      client.call('workflows.get', { name: 'report' }),
    ).rejects.toThrow(
      new NotFoundError(
        "Workflow report isn't loaded: data/Settings/Workflows/Report.md has errors; pero check lists them",
      ),
    );
    expect((await client.call('workflows.list')).workflows).toEqual([]);
    expect(
      (await client.call('status')).components.find(
        ({ name }) => name === 'settings',
      ),
    ).toMatchObject({
      state: 'degraded',
      detail: '1 note has errors; run pero check',
    });
    expect((await client.call('check')).problems).toEqual([
      {
        file: 'data/Settings/Workflows/Report.md',
        property: 'channel',
        message: 'no topic titled "Helth"; seen topics: none yet',
      },
    ]);
  });

  it('reports each broken version of a Workflow note once in Telegram, in its Channel, and not its fix', async () => {
    const { channel } = await englishTopic();
    const reports = () => texts().filter((text) => text.startsWith('Errors'));

    await manualBrief([`channel: [${channel.id}, Helth]`]);
    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    expect(api.sent().at(-1)).toMatchObject({
      chat_id: String(FORUM.id),
      message_thread_id: 7,
      text: [
        'Errors in data/Settings/Workflows/Brief.md:',
        'channel: no topic titled "Helth"; seen topics: none yet',
        "It's left out until it's fixed.",
      ].join('\n'),
    });
    // Scanned again, unchanged: not posted again.
    await daemon!.app.get(SettingsNotes).refresh();

    await manualBrief([`channel: [${channel.id}, Hleth]`]);
    await vi.waitFor(() => expect(reports()).toHaveLength(2));
    expect(reports()[1]).toContain('channel: no topic titled "Hleth"');

    await manualBrief([`channel: ${channel.id}`]);
    await daemon!.app.get(BrokenNoteReports).idle();
    expect(reports()).toHaveLength(2);
    expect(
      (await client.call('workflows.get', { name: 'brief' })).errors,
    ).toEqual([]);
    // Not part of the topic's conversation.
    const { messages } = await client.call('channels.history', {
      id: channel.id,
    });
    expect(messages.map(({ text }) => text)).not.toContainEqual(
      expect.stringMatching(/^Errors/),
    );
  });

  it('runs any Workflow by hand, away from every Channel', async () => {
    await start();
    await workflow('Brief', ['agent: coach', 'hour: 9'], 'Summarize the day.');

    await expect(
      client.call('workflows.run', { name: 'nothing' }),
    ).rejects.toThrow(new NotFoundError('No Workflow named nothing'));
    await expect(client.call('runs.get', { id: 99 })).rejects.toThrow(
      new NotFoundError('No run with ID 99'),
    );

    const queued = await client.call('workflows.run', { name: 'brief' });
    expect(queued).toMatchObject({
      workflow: 'brief',
      attempt: 1,
    });
    await vi.waitFor(async () => {
      expect(await client.call('runs.get', { id: queued.id })).toMatchObject({
        status: 'completed',
        result: 'echo: Summarize the day.',
        error: null,
      });
    });
    // No Channel took part.
    expect((await client.call('channels.list')).channels).toEqual([]);

    await restart();
    expect(await client.call('runs.get', { id: queued.id })).toMatchObject({
      status: 'completed',
      result: 'echo: Summarize the day.',
    });
  });

  it('reads the history input its note asks for, and completes a run with none to read without its Agent', async () => {
    await start();
    const english = (props: string[] = []) =>
      workflow(
        'English',
        ['agent: coach', 'history: true', 'history-messages: people', ...props],
        'Suggest improvements:\n{{history}}',
      );
    await english(['history-channels: 42']);
    await expect(
      client.call('workflows.run', { name: 'english' }),
    ).rejects.toThrow(/^Workflow english isn't loaded: /);
    expect((await client.call('check')).problems).toEqual([
      expect.objectContaining({
        property: 'history-channels',
        message: 'no Channel has the ID 42',
      }),
    ]);

    await english();
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
    await english(['run-when-empty: true']);
    const ran = await client.call('workflows.run', { name: 'english' });
    await vi.waitFor(async () => {
      expect(await client.call('runs.get', { id: ran.id })).toMatchObject({
        status: 'completed',
        skipped: false,
        result: 'echo: Suggest improvements:\n[No messages in this window]',
      });
    });

    await workflow('English', ['agent: coach'], 'Suggest improvements.');
    expect(
      (await client.call('workflows.get', { name: 'english' })).history,
    ).toBeNull();
  });

  it('starts one catch-up run for the times a schedule missed while Pero was down', async () => {
    const HOUR_MS = 60 * 60 * 1000;
    await workflow(
      'Hourly',
      ['agent: coach', "cron: '0 * * * *'", 'timezone: UTC'],
      'Check the inbox.',
    );
    // Startup gives the schedule its saved times.
    await start();

    // Down since the top of the hour three hours ago.
    await daemon!.stop('downtime');
    daemon = undefined;
    const lastHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const due = new Date(lastHour - 3 * HOUR_MS);
    const db = new Database(database);
    db.prepare(
      `UPDATE "schedules" SET "next_run_at" = ? WHERE "workflow_name" = ?`,
    ).run(due.toISOString().replace('T', ' ').replace('Z', ''), 'hourly');
    db.close();

    await start();
    await vi.waitFor(async () => {
      expect(await client.call('runs.get', { id: 1 })).toMatchObject({
        workflow: 'hourly',
        triggerKey: `schedule:hourly:${due.toISOString()}`,
        // The three hours since; the first missed time is the run itself.
        skippedCount: 3,
        status: 'completed',
        result: 'echo: Check the inbox.',
      });
    });
    const listed = (await client.call('workflows.get', { name: 'hourly' }))
      .schedule;
    expect(listed!.nextRunAt).toBe(new Date(lastHour + HOUR_MS).toISOString());
    expect(listed!.lastRunAt).not.toBeNull();

    await restart();
    await expect(client.call('runs.get', { id: 2 })).rejects.toThrow(
      new NotFoundError('No run with ID 2'),
    );
  });

  it('applies an edited schedule at once, and cancels the runs a schedule queued once its note is disabled or deleted', async () => {
    const HOUR_MS = 60 * 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;
    /** The next time it is `hour` o'clock in UTC. */
    const nextAt = (hour: number) => {
      const today = Math.floor(Date.now() / DAY_MS) * DAY_MS + hour * HOUR_MS;
      return new Date(today > Date.now() ? today : today + DAY_MS);
    };
    const daily = (properties: string[]) =>
      workflow(
        'Daily',
        ['agent: coach', 'timezone: UTC', ...properties],
        'Plan the day.',
      );
    const nextRunAt = async () =>
      (await client.call('workflows.get', { name: 'daily' })).schedule!
        .nextRunAt;
    await daily(['hour: 9']);
    await start();
    expect(await nextRunAt()).toBe(nextAt(9).toISOString());

    await daily(['hour: 10']);
    await daemon!.app.get(ScheduleTick).reconciled();
    expect(await nextRunAt()).toBe(nextAt(10).toISOString());

    // A run by hand holds the Workflow, so the one its schedule queued waits.
    const held = claude().hold();
    const byHand = await client.call('workflows.run', { name: 'daily' });
    await held.started;
    const runs = daemon!.app
      .get<DataSource>(getDataSourceToken())
      .getRepository(WorkflowRun);
    const { identifiers } = await runs.insert({
      workflowName: 'daily',
      triggerKey: `schedule:daily:${nextAt(10).toISOString()}`,
      status: 'pending',
    });
    const scheduled = identifiers[0]!.id as number;

    await daily(['hour: 10', 'enabled: false']);
    await daemon!.app.get(ScheduleTick).reconciled();
    expect(await nextRunAt()).toBeNull();
    expect(await client.call('runs.get', { id: scheduled })).toMatchObject({
      status: 'cancelled',
      error: 'Cancelled before it started: Workflow daily is disabled',
    });
    held.release();
    expect(await waitFinished(byHand.id)).toMatchObject({
      status: 'completed',
    });

    // Enabled again, then deleted with a run waiting.
    await daily(['hour: 10']);
    await daemon!.app.get(ScheduleTick).reconciled();
    expect(await nextRunAt()).toBe(nextAt(10).toISOString());
    const again = claude().hold();
    const second = await client.call('workflows.run', { name: 'daily' });
    await again.started;
    const waiting = await client.call('workflows.run', { name: 'daily' });
    rmSync(join(workspace, 'data', 'Settings', 'Workflows', 'Daily.md'));
    await daemon!.app.get(SettingsNotes).refresh();
    await daemon!.app.get(ScheduleTick).reconciled();
    expect(await client.call('runs.get', { id: waiting.id })).toMatchObject({
      status: 'cancelled',
      startedAt: null,
      error: 'Cancelled before it started: Workflow daily no longer exists',
    });
    // The running one finishes.
    again.release();
    expect(await waitFinished(second.id)).toMatchObject({
      status: 'completed',
    });
    expect(
      await daemon!.app
        .get<DataSource>(getDataSourceToken())
        .query(`SELECT * FROM "schedules"`),
    ).toEqual([]);
  });

  it('records a run Pero stopped as interrupted on the next start, and retries it as its Workflow allows', async () => {
    await start();
    await manualBrief(['max-attempts: 2']);
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
    await pero(['max-concurrent-runs: 1']);
    await workflow('Other', ['agent: coach'], 'Something else.');
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

  it(
    'runs the weekly report from the overview by hand, answered by the Health Agent, and posts it in Health',
    { timeout: 30_000 },
    async () => {
      await pero(['timezone: Europe/Berlin']);
      write(
        'Agents/Health.md',
        '---\ntopics: [Health]\neffort: high\n---\nYou are my health coach.',
      );
      await workflow(
        'Weekly health report',
        ['day: sunday', 'hour: 12', 'minute: 0', 'channel: Health'],
        '# Workflow Instruction\nCreate a weekly report from Health/Log.md.',
      );
      api.chats.set(String(FORUM.id), FORUM);
      await start();
      await client.call('telegram.token', { token: TOKEN });
      await vi.waitFor(async () =>
        expect((await client.call('telegram.chats')).bot).toBe('pero_test_bot'),
      );
      await client.call('telegram.allow', { chatId: String(FORUM.id) });
      // Until Pero has seen the topic, the note can't name it.
      expect(
        (await client.call('check')).problems.map(({ message }) => message),
      ).toEqual(['no topic titled "Health"; seen topics: none yet']);

      api.push({
        message: {
          message_id: 1,
          date: 0,
          chat: FORUM,
          from: OWNER,
          message_thread_id: 9,
          is_topic_message: true,
          forum_topic_created: { name: 'Health', icon_color: 0 },
        } as never,
      });
      await vi.waitFor(async () =>
        expect(
          (await client.call('channels.list')).channels.map(({ key }) => key),
        ).toContain(`${FORUM.id}:9`),
      );
      await daemon!.app.get(SettingsNotes).refresh();

      const report = await client.call('workflows.get', {
        name: 'weekly-health-report',
      });
      expect(report).toMatchObject({
        agent: 'health',
        channels: [{ key: `${FORUM.id}:9`, title: 'Health' }],
        schedule: { cron: '0 12 * * 0', timezone: 'Europe/Berlin' },
      });
      const { id } = await client.call('workflows.run', {
        name: 'weekly-health-report',
      });
      expect(await waitFinished(id)).toMatchObject({
        status: 'completed',
        result:
          'echo: # Workflow Instruction\nCreate a weekly report from Health/Log.md.',
      });
      expect(claude().requests.at(-1)).toMatchObject({
        providerOptions: { effort: 'high' },
      });
      await daemon!.app
        .get(NotificationDelivery)
        .tick(new Date(Date.now() + 1_000));
      expect(api.sent().at(-1)).toMatchObject({
        message_thread_id: 9,
        text: 'Weekly health report\n\necho: # Workflow Instruction\nCreate a weekly report from Health/Log.md.',
      });
    },
  );

  it('notifies the Channels a Workflow names of each finished run, keeping the Notifications across a restart', async () => {
    await start();
    const dataSource = daemon!.app.get<DataSource>(getDataSourceToken());
    const channels = dataSource.getRepository(Channel);
    const { id: channel } = await channels.save(
      channels.create({
        integrationKind: 'telegram',
        externalKey: '-1001234567890:7',
        address: { chatId: '-1001234567890', topicId: '7' },
        title: 'English',
      }),
    );
    daemon!.app.get(HostConfigService).allow('-1001234567890', 'Household');
    await manualBrief(['channel: English']);

    expect(
      (await client.call('workflows.get', { name: 'brief' })).channels,
    ).toEqual([
      {
        id: channel,
        integrationKind: 'telegram',
        key: '-1001234567890:7',
        title: 'English',
      },
    ]);

    const queued = await client.call('workflows.run', { name: 'brief' });
    await vi.waitFor(async () => {
      expect(await client.call('runs.get', { id: queued.id })).toMatchObject({
        status: 'completed',
      });
    });

    await restart();
    const db = new Database(database, { readonly: true });
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
          payload: JSON.stringify({ text: SUMMARY }),
        },
      ]);
    } finally {
      db.close();
    }

    await manualBrief();
    expect(
      (await client.call('workflows.get', { name: 'brief' })).channels,
    ).toEqual([]);
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
      const suggestion = SUMMARY;
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

      // A Notification to a chat denied since its run fails, and is
      // delivered once retried after the chat is allowed again.
      await delivery.tick(new Date(Date.now() + 1_000));
      expect(
        (await client.call('runs.get', { id: queued.id })).notifications,
      ).toEqual([expect.objectContaining({ status: 'delivered' })]);
      const denied = await runBrief();
      await client.call('telegram.deny', { chatId: String(FORUM.id) });
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
        text: SUMMARY,
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
          text: SUMMARY,
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
        SUMMARY,
        SUMMARY,
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

      await pero(['history-retention-days: 30']);
      expect(await client.call('settings.get')).toMatchObject({
        historyRetentionDays: 30,
      });
      await restart();

      await vi.waitFor(async () =>
        expect(await history()).toEqual(['Recent', 'echo: Recent']),
      );
      expect(
        await client.call('channels.get', { id: channel.id }),
      ).toMatchObject({ messages: 2 });
      await pero();
      expect(
        (await client.call('settings.get')).historyRetentionDays,
      ).toBeNull();
    },
  );
});
