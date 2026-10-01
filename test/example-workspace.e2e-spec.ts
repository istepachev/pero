import { execFile } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Chat, Message, User } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import { readHostConfig } from '../src/config/host-config.js';
import {
  type ControlClient,
  createControlClient,
} from '../src/control/client.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';
import type { RuntimeRequest } from '../src/runtimes/agent-runtime.js';
import { AgentRuntimes } from '../src/runtimes/agent-runtimes.js';
import type { FakeAgentRuntime } from '../src/runtimes/testing/fake-agent-runtime.js';
import { NotificationDelivery } from '../src/notifications/notification-delivery.js';
import { ScheduleTick } from '../src/scheduler/schedule-tick.js';
import { SettingsNotes } from '../src/settings/settings-notes.service.js';
import { FakeBotApi } from '../src/telegram/testing/fake-bot-api.js';

// `npm run test:e2e` builds first.
const PERO = join(import.meta.dirname, '../bin/pero.js');
const EXAMPLE = join(import.meta.dirname, '../examples/workspace');

const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';
const OWNER: User = { id: 1234, is_bot: false, first_name: 'Ada' };
const HEALTH = 42;
const FINANCE = 43;

describe('The example workspace (e2e)', { timeout: 60_000 }, () => {
  let tmp: string;
  let workspace: string;
  let forum: Chat.SupergroupChat;
  let client: ControlClient;
  let daemon: Daemon | undefined;
  let api: FakeBotApi;
  let nextMessageId: number;

  beforeEach(async () => {
    // Short: macOS limits socket paths to 104 bytes.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-')));
    workspace = join(tmp, 'ws');
    cpSync(EXAMPLE, workspace, { recursive: true });
    // The fake Telegram has the group the example allows, as it is.
    const [allowed] = readHostConfig(
      join(workspace, '.pero', 'config.yaml'),
    )!.allowedChats;
    forum = {
      id: Number(allowed!.chatKey),
      type: 'supergroup',
      title: allowed!.title!,
      is_forum: true,
    };
    api = new FakeBotApi();
    api.chats.set(allowed!.chatKey, forum);
    await api.listen();
    client = createControlClient(join(workspace, '.pero', 'run', 'pero.sock'));
    nextMessageId = 1;
  });

  afterEach(async () => {
    await daemon?.stop('test finished');
    daemon = undefined;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Starts Pero in the copy, with the token in its `.env`, Telegram the
   * fake Bot API, and Agents that echo.
   */
  async function start() {
    writeFileSync(
      join(workspace, '.env'),
      `PERO_TELEGRAM_BOT_TOKEN=${TOKEN}\n`,
      { mode: 0o600 },
    );
    daemon = await startDaemon({
      config: resolveBootstrapConfig({ workspace, env: {} }),
      foreground: false,
      env: { PERO_TELEGRAM_API_ROOT: api.url, PERO_FAKE_RUNTIME: 'echo' },
    });
    await vi.waitFor(async () =>
      expect((await client.call('telegram.chats')).bot).toBe('pero_test_bot'),
    );
  }

  /** Writes to the forum as the owner: in topic `thread`, or in General. */
  function post(fields: Partial<Message>, thread?: number): void {
    api.push({
      message: {
        message_id: nextMessageId++,
        date: 0,
        chat: forum,
        from: OWNER,
        ...(thread === undefined
          ? {}
          : { message_thread_id: thread, is_topic_message: true }),
        ...fields,
      } as never,
    });
  }

  /** Posts `text` in `thread` and resolves to what the bot sent back. */
  async function say(text: string, thread?: number): Promise<string> {
    const before = api.sent().length;
    post({ text }, thread);
    await vi.waitFor(() => expect(api.sent()).toHaveLength(before + 1));
    const [answer] = api.sent().slice(before);
    expect(answer).toMatchObject(
      thread === undefined ? {} : { message_thread_id: thread },
    );
    return String(answer!.text);
  }

  /** Creates topic `name` as `thread`, resolving to Pero's welcome. */
  async function createTopic(name: string, thread: number): Promise<string> {
    const before = api.sent().length;
    post({ forum_topic_created: { name, icon_color: 0 } }, thread);
    await vi.waitFor(() => expect(api.sent()).toHaveLength(before + 1));
    return String(api.sent().at(-1)!.text);
  }

  /** The request of the Claude turn that answered last. */
  function lastRequest(): RuntimeRequest {
    const runtime = daemon!.app
      .get(AgentRuntimes)
      .get('claude') as FakeAgentRuntime;
    return runtime.requests.at(-1)!;
  }

  /** The settings folder's note at `file`. */
  const settings = (file: string) => join(workspace, 'data', 'Settings', file);

  it('passes pero check as committed', async () => {
    const result = await new Promise<{ code: number; stdout: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          [PERO, 'check', '--workspace', EXAMPLE],
          { env: { ...process.env, HOME: tmp } },
          (error, stdout) =>
            resolve({ code: error ? Number(error.code) : 0, stdout }),
        );
      },
    );
    expect(result).toEqual({
      code: 0,
      stdout: expect.stringMatching(
        /^Checked 2 Agents and 2 Workflows in data\/Settings: no problems\./,
      ),
    });
    // Checking writes nothing into the example.
    expect(readdirSync(join(EXAMPLE, '.pero')).sort()).toEqual([
      '.gitignore',
      'config.yaml',
    ]);
  });

  it('answers each topic by its note, writes notes for new topics, applies edits, and runs the weekly report', async () => {
    await start();

    // Health answers the Health topic, with Pero's shared instructions.
    expect(await createTopic('Health', HEALTH)).toMatch(
      /^This topic talks to Agent health: claude, model opus, working in /,
    );
    expect(await say('Ran 5 km', HEALTH)).toBe('echo: Ran 5 km');
    expect(lastRequest()).toMatchObject({
      instructions: expect.stringMatching(
        /^You are a calm, concise personal assistant\..*\n\nYou are my health coach\./s,
      ),
      providerOptions: { model: 'opus', effort: 'high' },
      workingDirectory: join(workspace, 'data'),
    });

    // A new topic writes its note from the template, whose Agent answers.
    expect(await createTopic('Finance', FINANCE)).toMatch(
      /^This topic talks to Agent finance: /,
    );
    const template = readFileSync(settings('Agents/_Template.md'), 'utf8');
    expect(readFileSync(settings('Agents/Finance.md'), 'utf8')).toBe(
      template.replace(/\n---\n/, '\n\ntopics:\n  - Finance\n---\n'),
    );
    expect(await say('Paid rent', FINANCE)).toBe('echo: Paid rent');
    expect(lastRequest().instructions).toContain(
      'You are my assistant for this topic.',
    );

    // Editing Health's note changes its next answer.
    const health = settings('Agents/Health.md');
    writeFileSync(
      health,
      readFileSync(health, 'utf8')
        .replace('effort: high', 'effort: low')
        .replace('You are my health coach.', 'You are my running coach.'),
    );
    const later = new Date(Date.now() + 60_000);
    utimesSync(health, later, later);
    await daemon!.app.get(SettingsNotes).refresh();
    expect(await say('Swam 1 km', HEALTH)).toBe('echo: Swam 1 km');
    expect(lastRequest()).toMatchObject({
      instructions: expect.stringMatching(/\n\nYou are my running coach\./),
      providerOptions: { model: 'opus', effort: 'low' },
    });

    // The weekly report, once its Health topic is seen, is due Sunday at
    // 12:00 in Pero.md's time zone.
    await daemon!.app.get(SettingsNotes).refresh();
    await daemon!.app.get(ScheduleTick).reconciled();
    const report = await client.call('workflows.get', {
      name: 'weekly-health-report',
    });
    expect(report).toMatchObject({ agent: 'health', errors: [] });
    const nextRunAt = new Date(report.schedule!.nextRunAt!);
    expect(
      nextRunAt.toLocaleString('en-GB', {
        timeZone: 'Europe/Berlin',
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
      }),
    ).toBe('Sunday 12:00');

    // The scheduler's clock reaches that time: the run posts to Health.
    const before = api.sent().length;
    await daemon!.app.get(ScheduleTick).tick(nextRunAt);
    await vi.waitFor(async () =>
      expect((await client.call('runs.list', {})).runs).toEqual([
        expect.objectContaining({
          workflow: 'weekly-health-report',
          triggerKey: `schedule:weekly-health-report:${nextRunAt.toISOString()}`,
          status: 'completed',
        }),
      ]),
    );
    // Delivered at the next delivery tick, which comes at once here.
    await daemon!.app.get(NotificationDelivery).tick();
    expect(api.sent()).toHaveLength(before + 1);
    const posted = api.sent().at(-1)!;
    expect(posted).toMatchObject({
      chat_id: String(forum.id),
      message_thread_id: HEALTH,
    });
    expect(String(posted.text)).toMatch(
      /^Weekly health report\n\necho: # Workflow Instruction\nCreate a weekly report in the Reports directory from Health\/Log\.md/,
    );

    // Once General is seen too, every reference in the example resolves.
    const seen = api.sent().length;
    post({ text: 'Hello' });
    await vi.waitFor(() => expect(api.sent()).toHaveLength(seen + 2));
    expect(api.sent().slice(seen)).toEqual([
      expect.objectContaining({
        text: expect.stringMatching(/^This chat talks to Agent main: /),
      }),
      expect.objectContaining({ text: 'echo: Hello' }),
    ]);
    expect(lastRequest().instructions).toContain(
      'You help with everyday questions and keep my notes tidy.',
    );
    await daemon!.app.get(SettingsNotes).refresh();
    await expect(client.call('check')).resolves.toMatchObject({
      agents: 3,
      workflows: 2,
      topicsChecked: true,
      problems: [],
    });
  });
});
