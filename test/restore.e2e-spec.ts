import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Chat, Message, User } from 'grammy/types';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import type { Provider } from '../src/config/provider-options.js';
import {
  type ControlClient,
  createControlClient,
} from '../src/control/client.js';
import type { RunDetails } from '../src/control/protocol.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';
import { Session } from '../src/persistence/entities/session.entity.js';
import {
  type RuntimeRequest,
  RuntimeError,
} from '../src/runtimes/agent-runtime.js';
import { AgentRuntimes } from '../src/runtimes/agent-runtimes.js';
import type { FakeAgentRuntime } from '../src/runtimes/testing/fake-agent-runtime.js';
import {
  FakeBotApi,
  type UpdateBody,
} from '../src/telegram/testing/fake-bot-api.js';

/*
 * The restore drill of docs/OPERATIONS.md as one story, through the fake
 * Bot API and the echo runtime: an installation with Agents, Channels,
 * Workflows, Triggers, and Sessions is backed up while it runs, restored on
 * a "fresh machine" whose working folders come from the owner's own
 * backup, and carries on where it stopped.
 */

// `npm run test:e2e` builds first.
const PERO = join(import.meta.dirname, '../bin/pero.js');

const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';

const FORUM: Chat.SupergroupChat = {
  id: -1001234567890,
  type: 'supergroup',
  title: 'Household',
  is_forum: true,
};
const DIRECT: Chat.PrivateChat = {
  id: 1234,
  type: 'private',
  first_name: 'Ada',
};
const OWNER: User = { id: 1234, is_bot: false, first_name: 'Ada' };
const ENGLISH = 42;
const KITCHEN = 43;

/** Every Channel of the story: its chat, and its topic when it has one. */
const CHANNELS: [Chat, number | null][] = [
  [FORUM, ENGLISH],
  [FORUM, KITCHEN],
  [FORUM, null],
  [DIRECT, null],
];

describe('Restore drill (e2e)', () => {
  let tmp: string;
  let vault: string;
  let own: string;
  let daemon: Daemon | undefined;
  let client: ControlClient;
  let api: FakeBotApi;
  let nextMessageId: number;

  beforeEach(async () => {
    api = new FakeBotApi();
    api.chats.set(String(FORUM.id), FORUM);
    await api.listen();
    // Short: macOS limits socket paths to 104 bytes.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-')));
    vault = join(tmp, 'vault');
    own = join(tmp, 'own');
    mkdirSync(vault);
    mkdirSync(own);
    nextMessageId = 1;
  });

  afterEach(async () => {
    await daemon?.stop('test finished');
    daemon = undefined;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A daemon on `root` and the fake Bot API whose Agents answer with an echo. */
  async function start(root: string) {
    daemon = await startDaemon({
      config: resolveBootstrapConfig({ dataDir: root, env: {} }),
      foreground: false,
      env: { PERO_TELEGRAM_API_ROOT: api.url, PERO_FAKE_RUNTIME: 'echo' },
    });
    client = createControlClient(join(root, 'run', 'pero.sock'));
  }

  async function connected() {
    await vi.waitFor(async () =>
      expect((await client.call('telegram.chats')).bot).toBe('pero_test_bot'),
    );
  }

  async function stop() {
    await daemon!.stop('drill');
    daemon = undefined;
  }

  function dataSource(): DataSource {
    return daemon!.app.get<DataSource>(getDataSourceToken());
  }

  function sessions(): Promise<Session[]> {
    return dataSource()
      .getRepository(Session)
      .find({ order: { id: 'ASC' } });
  }

  function runtime(provider: Provider): FakeAgentRuntime {
    return daemon!.app.get(AgentRuntimes).get(provider) as FakeAgentRuntime;
  }

  function lastRequest(provider: Provider): RuntimeRequest {
    return runtime(provider).requests.at(-1)!;
  }

  function send(chat: Chat, topic: number | null, fields: Partial<Message>) {
    api.push({
      message: {
        message_id: nextMessageId++,
        date: 0,
        chat,
        from: OWNER,
        ...(topic === null
          ? {}
          : { message_thread_id: topic, is_topic_message: true }),
        ...fields,
      } as never,
    } satisfies UpdateBody);
  }

  /** Sends `text` and resolves to the one answer it gets there. */
  async function say(
    chat: Chat,
    topic: number | null,
    text: string,
  ): Promise<string> {
    const before = api.sent().length;
    send(chat, topic, { text });
    let answers: Record<string, unknown>[] = [];
    await vi.waitFor(() => {
      answers = api
        .sent()
        .slice(before)
        .filter(
          (payload) =>
            String(payload.chat_id) === String(chat.id) &&
            payload.message_thread_id === (topic ?? undefined) &&
            String(payload.text).startsWith('echo: '),
        );
      expect(answers).toHaveLength(1);
    });
    return String(answers[0]!.text);
  }

  async function createTopic(topic: number, name: string) {
    send(FORUM, topic, { forum_topic_created: { name, icon_color: 0 } });
    await vi.waitFor(async () =>
      expect(
        (await client.call('channels.list')).channels.map((c) => c.key),
      ).toContain(`${FORUM.id}:${topic}`),
    );
  }

  async function channelId(chat: Chat, topic: number | null): Promise<number> {
    const key = topic === null ? String(chat.id) : `${chat.id}:${topic}`;
    const { channels } = await client.call('channels.list');
    return channels.find((channel) => channel.key === key)!.id;
  }

  /** Runs `english` by hand and waits until its Notification is delivered. */
  async function runEnglish(): Promise<RunDetails> {
    const { id } = await client.call('workflows.run', { name: 'english' });
    let run: RunDetails | undefined;
    await vi.waitFor(
      async () => {
        run = await client.call('runs.get', { id });
        expect(run.status).toBe('completed');
        expect(run.notifications.map((n) => n.status)).toEqual(['delivered']);
      },
      { timeout: 15_000, interval: 200 },
    );
    return run!;
  }

  /** What a restore must bring back, as the control endpoint shows it. */
  async function definitions() {
    const { agents } = await client.call('agents.list');
    const { channels } = await client.call('channels.list');
    const { workflows } = await client.call('workflows.list');
    return {
      settings: await client.call('settings.get'),
      agents: await Promise.all(
        agents.map(({ name }) => client.call('agents.get', { name })),
      ),
      channels: await Promise.all(
        channels.map(({ id }) => client.call('channels.get', { id })),
      ),
      workflows: await Promise.all(
        workflows.map(({ name }) => client.call('workflows.get', { name })),
      ),
      triggers: (await client.call('triggers.list', {})).triggers,
      allowed: (await client.call('telegram.chats')).allowed.map(
        ({ chatId, kind, title }) => ({ chatId, kind, title }),
      ),
    };
  }

  /**
   * Runs the built `pero` CLI from `tmp`, without PERO_HOME,
   * PERO_WORKSPACE, or a token in its environment.
   */
  function pero(args: string[]): Promise<{ code: number; stderr: string }> {
    const {
      PERO_HOME: _home,
      PERO_WORKSPACE: _workspace,
      PERO_TELEGRAM_BOT_TOKEN: _token,
      ...env
    } = process.env;
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [PERO, ...args],
        { env, cwd: tmp },
        (error, _, stderr) =>
          resolve({ code: error ? Number(error.code) : 0, stderr }),
      );
    });
  }

  it('brings back definitions and resumable Sessions on a fresh machine', async () => {
    // An installation in use: Channels with Sessions, an Agent with its own
    // folder, and a Workflow that reads history and notifies a topic.
    await start(join(tmp, 'pero'));
    await client.call('settings.update', {
      defaultWorkingDirectory: vault,
      telegramBotToken: TOKEN,
      timezone: 'Europe/Lisbon',
      historyCarryover: 20,
      sharedInstructions: 'Be brief.',
    });
    await connected();
    await client.call('telegram.allow', { chatId: String(FORUM.id) });
    await client.call('telegram.allow', { chatId: String(DIRECT.id) });
    await createTopic(ENGLISH, 'English');
    await createTopic(KITCHEN, 'Kitchen');
    await client.call('agents.create', {
      name: 'coder',
      provider: 'codex',
      workingDirectory: own,
      codexSkipGitRepoCheck: true,
    });
    await client.call('channels.assign', {
      id: await channelId(FORUM, KITCHEN),
      agent: 'coder',
    });
    for (const [chat, topic] of CHANNELS) {
      expect(await say(chat, topic, 'Hello')).toBe('echo: Hello');
    }
    await client.call('workflows.create', {
      name: 'english',
      title: 'English review',
      agent: 'english',
      inputTemplate: 'Suggest better English for: {{history}}',
      maxAttempts: 2,
      history: {},
    });
    await client.call('triggers.add', {
      workflow: 'english',
      kind: 'schedule',
      cron: '0 21 * * *',
    });
    await client.call('triggers.add', { workflow: 'english', kind: 'manual' });
    await client.call('workflows.notify', {
      name: 'english',
      channel: await channelId(FORUM, ENGLISH),
      notify: true,
    });
    expect((await runEnglish()).history).toMatchObject({ count: 4 });

    const before = await definitions();
    expect(before.channels.map((channel) => channel.nextTurn.kind)).toEqual([
      'resume',
      'resume',
      'resume',
      'resume',
    ]);
    const recorded = await sessions();
    expect(recorded).toHaveLength(4);
    expect(recorded.map((session) => session.provider).sort()).toEqual([
      'claude',
      'claude',
      'claude',
      'codex',
    ]);

    // Backed up while Pero runs, then the machine is gone.
    const file = join(tmp, 'pero.tgz');
    await client.call('backup.create', { file });
    await stop();
    rmSync(join(tmp, 'pero'), { recursive: true });

    // A fresh machine: the working folders come back from the owner's own
    // backup, at the same paths, then Pero's backup is restored.
    for (const folder of [vault, own]) {
      cpSync(folder, `${folder}.owner-backup`, { recursive: true });
      rmSync(folder, { recursive: true });
      cpSync(`${folder}.owner-backup`, folder, { recursive: true });
    }
    const restored = join(tmp, 'restored');
    expect(await pero(['restore', file, '--data-dir', restored])).toEqual({
      code: 0,
      stderr: '',
    });

    // The same definitions, and every Channel resumes its provider session.
    await start(restored);
    await connected();
    expect(await definitions()).toEqual(before);
    for (const [index, [chat, topic]] of CHANNELS.entries()) {
      const id = await channelId(chat, topic);
      const session = recorded.find((s) => s.channelId === id)!;
      const text = `Back ${index}`;
      const answer = await say(chat, topic, text);
      const request = lastRequest(session.provider);
      expect(request).toMatchObject({
        providerSessionId: session.providerSessionId,
        workingDirectory: session.workingDirectory,
      });
      expect(answer).toBe(`echo: ${request.input}`);
      // The suggestion the Workflow posted before the backup comes along
      // where it was posted, so the owner can reply to it.
      expect(request.input).toEqual(
        topic === ENGLISH
          ? expect.stringMatching(
              /^\[Posted in this chat by Workflows since the last message here\]\n.* Workflow english: English review\n.*\n\nBack 0$/s,
            )
          : text,
      );
    }
    expect(
      (await sessions()).map(({ id, status, providerSessionId }) => ({
        id,
        status,
        providerSessionId,
      })),
    ).toEqual(
      recorded.map(({ id, status, providerSessionId }) => ({
        id,
        status,
        providerSessionId,
      })),
    );

    // The Workflow reads on from where its last run stopped.
    expect((await runEnglish()).history).toMatchObject({ count: 4 });

    // A provider that no longer has a conversation, as when its own session
    // store was not restored: the turn answers in a fresh Session that
    // starts from the Channel's history.
    const english = await channelId(FORUM, ENGLISH);
    const lost = recorded.find((s) => s.channelId === english)!;
    runtime('claude').failNext(
      new RuntimeError(
        'session_lost',
        `No conversation found with session ID: ${lost.providerSessionId}`,
      ),
    );
    const answer = await say(FORUM, ENGLISH, 'Still there?');
    expect(answer).toMatch(
      /^echo: \[Earlier conversation in this chat, from a previous session\]\n.* User: Hello\n.*\n\nStill there\?$/s,
    );
    expect(lastRequest('claude').providerSessionId).toBeUndefined();
    expect((await sessions()).filter((s) => s.channelId === english)).toEqual([
      expect.objectContaining({ id: lost.id, status: 'closed' }),
      expect.objectContaining({
        status: 'active',
        providerSessionId: expect.any(String),
      }),
    ]);
    expect(
      (await client.call('channels.get', { id: english })).nextTurn.kind,
    ).toBe('resume');
  }, 90_000);
});
