import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Chat, Message, User } from 'grammy/types';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import type { Provider } from '../src/config/provider-options.js';
import { initWorkspace } from '../src/config/workspace-skeleton.js';
import {
  type ControlClient,
  createControlClient,
} from '../src/control/client.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';
import { Session } from '../src/persistence/entities/session.entity.js';
import type { RuntimeRequest } from '../src/runtimes/agent-runtime.js';
import { AgentRuntimes } from '../src/runtimes/agent-runtimes.js';
import type { FakeAgentRuntime } from '../src/runtimes/testing/fake-agent-runtime.js';
import { SystemNotes } from '../src/system/system-notes.service.js';
import {
  FakeBotApi,
  type UpdateBody,
} from '../src/telegram/testing/fake-bot-api.js';

/*
 * The interactive path as one story, through the fake Bot API and the
 * echo runtime: pairing, topic onboarding, the Default Channel's General
 * topic and direct chat, a daemon restart, and provider and folder changes
 * made in Channel notes.
 */

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
const GROCERIES = 42;
const KITCHEN = 43;

const GROCERIES_KEY = `${FORUM.id}:${GROCERIES}`;
const KITCHEN_KEY = `${FORUM.id}:${KITCHEN}`;
const GENERAL_KEY = String(FORUM.id);
const DIRECT_KEY = String(DIRECT.id);

describe('Interactive path end to end (e2e)', () => {
  let tmp: string;
  let workspace: string;
  let vault: string;
  let other: string;
  let client: ControlClient;
  let daemon: Daemon | undefined;
  let api: FakeBotApi;
  let nextMessageId: number;
  /** How many answers `say` has waited for. */
  let answers: number;
  /** Each edit gets a later modification time, whatever the clock. */
  let clock: number;

  beforeEach(async () => {
    api = new FakeBotApi();
    api.chats.set(String(FORUM.id), FORUM);
    await api.listen();
    // Short: macOS limits socket paths to 104 bytes.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-')));
    workspace = join(tmp, 'ws');
    initWorkspace(workspace, tmp);
    vault = join(workspace, 'data');
    other = join(tmp, 'other');
    mkdirSync(other);
    client = createControlClient(join(workspace, '.pero', 'run', 'pero.sock'));
    nextMessageId = 1;
    answers = 0;
    clock = Date.parse('2026-01-01T00:00:00Z');
  });

  afterEach(async () => {
    await daemon?.stop('test finished');
    daemon = undefined;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Writes the Channel note `Channels/<title>.md` and has Pero read it. */
  async function note(title: string, properties: string[], body: string) {
    const path = join(vault, 'System', 'Channels', `${title}.md`);
    writeFileSync(path, ['---', ...properties, '---', body, ''].join('\n'));
    clock += 1_000;
    utimesSync(path, new Date(clock), new Date(clock));
    await daemon!.app.get(SystemNotes).rescan();
  }

  /** A daemon on the fake Bot API whose turns answer with an echo. */
  async function start() {
    daemon = await startDaemon({
      config: resolveBootstrapConfig({ workspace, env: {} }),
      foreground: false,
      env: { PERO_TELEGRAM_API_ROOT: api.url, PERO_FAKE_RUNTIME: 'echo' },
    });
  }

  async function connected() {
    await vi.waitFor(async () =>
      expect((await client.call('telegram.chats')).bot).toBe('pero_test_bot'),
    );
  }

  /** Stops the daemon and starts a new one on the same workspace. */
  async function restart() {
    await daemon!.stop('restart');
    daemon = undefined;
    await start();
    await connected();
  }

  function sessions(): Promise<Session[]> {
    return daemon!.app
      .get<DataSource>(getDataSourceToken())
      .getRepository(Session)
      .find({ order: { id: 'ASC' } });
  }

  /** The requests `provider`'s echo runtime has had since the daemon started. */
  function requests(provider: Provider): RuntimeRequest[] {
    const runtime = daemon!.app.get(AgentRuntimes).get(provider);
    return (runtime as FakeAgentRuntime).requests;
  }

  function lastRequest(provider: Provider): RuntimeRequest {
    return requests(provider).at(-1)!;
  }

  /**
   * A message in `chat`, in `topic` when given; otherwise in the General
   * topic or the direct chat. Resolves to its update ID.
   */
  function send(
    chat: Chat,
    topic: number | null,
    fields: Partial<Message>,
  ): number {
    return api.push({
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

  /** Whether `payload` was sent to `chat`, in `topic` when given. */
  function sentTo(
    payload: Record<string, unknown>,
    chat: Chat,
    topic: number | null,
  ): boolean {
    return (
      String(payload.chat_id) === String(chat.id) &&
      payload.message_thread_id === (topic ?? undefined)
    );
  }

  /** Sends `text` and resolves to the one answer it gets there. */
  async function say(
    chat: Chat,
    topic: number | null,
    text: string,
  ): Promise<string> {
    const before = api.sent().length;
    send(chat, topic, { text });
    let echoes: Record<string, unknown>[] = [];
    await vi.waitFor(() => {
      echoes = api
        .sent()
        .slice(before)
        .filter(
          (payload) =>
            sentTo(payload, chat, topic) &&
            String(payload.text).startsWith('echo: '),
        );
      expect(echoes).toHaveLength(1);
    });
    answers++;
    return String(echoes[0]!.text);
  }

  async function createTopic(topic: number, name: string) {
    send(FORUM, topic, {
      forum_topic_created: { name, icon_color: 0 },
    });
    await vi.waitFor(() =>
      expect(
        api
          .sent()
          .some(
            (payload) =>
              sentTo(payload, FORUM, topic) &&
              String(payload.text).startsWith('Pero answers in this topic '),
          ),
      ).toBe(true),
    );
  }

  async function channelIds(): Promise<Record<string, number>> {
    const { channels } = await client.call('channels.list');
    return Object.fromEntries(channels.map((c) => [c.key, c.id]));
  }

  /** The note each Channel is answered from, by its key. */
  async function channelNotes(): Promise<Record<string, string | null>> {
    const { channels } = await client.call('channels.list');
    return Object.fromEntries(channels.map((c) => [c.key, c.note]));
  }

  async function history(channelId: number) {
    const { messages } = await client.call('channels.history', {
      id: channelId,
    });
    return messages.map(({ direction, origin, text }) => [
      direction,
      origin,
      text,
    ]);
  }

  it('onboards topics, serves the Default Channel, resumes after a restart, and carries history into a new provider', async () => {
    await start();
    await client.call('telegram.token', { token: TOKEN });
    await connected();

    // A chat that is not allowed gets only the pairing hint.
    const unpaired = send(DIRECT, null, { text: 'Anyone there?' });
    await vi.waitFor(() => expect(api.sent()).toHaveLength(1));
    expect(api.sent()[0]).toMatchObject({ chat_id: DIRECT_KEY });
    expect(String(api.sent()[0]!.text)).toContain('pero telegram allow 1234');
    await vi.waitFor(() =>
      expect(
        api
          .callsOf('getUpdates')
          .some((call) => Number(call.payload.offset) > unpaired),
      ).toBe(true),
    );
    expect(await client.call('channels.list')).toEqual({
      channels: [],
      unusedNotes: [],
    });
    expect(requests('claude')).toEqual([]);
    expect(requests('codex')).toEqual([]);

    // The forum group and the direct chat are allowed; each new topic
    // gets a Channel note of its own, which Pero answers there with.
    await client.call('telegram.allow', { chatId: String(FORUM.id) });
    await client.call('telegram.allow', { chatId: DIRECT_KEY });
    await createTopic(GROCERIES, 'Groceries');
    await createTopic(KITCHEN, 'Kitchen');
    expect(await say(FORUM, GROCERIES, 'Milk')).toBe('echo: Milk');
    expect(await say(FORUM, KITCHEN, 'Soup')).toBe('echo: Soup');
    expect(await say(FORUM, GROCERIES, 'Eggs')).toBe('echo: Eggs');
    expect(await say(FORUM, KITCHEN, 'Stew')).toBe('echo: Stew');

    // Two topics, two contexts, one shared folder.
    const ids = await channelIds();
    const [groceries, kitchen] = await sessions();
    expect(groceries).toMatchObject({
      channelId: ids[GROCERIES_KEY],
      provider: 'claude',
      workingDirectory: workspace,
      status: 'active',
    });
    expect(kitchen).toMatchObject({
      channelId: ids[KITCHEN_KEY],
      provider: 'claude',
      workingDirectory: workspace,
      status: 'active',
    });
    expect(groceries).toMatchObject({ agentName: 'groceries' });
    expect(kitchen).toMatchObject({ agentName: 'kitchen' });
    expect(groceries!.providerSessionId).not.toBe(kitchen!.providerSessionId);
    const followUps = requests('claude').filter((request) =>
      ['Eggs', 'Stew'].includes(request.input),
    );
    expect(
      followUps.map(({ input, providerSessionId, workingDirectory }) => ({
        input,
        providerSessionId,
        workingDirectory,
      })),
    ).toEqual([
      {
        input: 'Eggs',
        providerSessionId: groceries!.providerSessionId,
        workingDirectory: workspace,
      },
      {
        input: 'Stew',
        providerSessionId: kitchen!.providerSessionId,
        workingDirectory: workspace,
      },
    ]);

    // The General topic and the direct chat share Default.md, each in a
    // Session of its own.
    expect(await say(FORUM, null, 'Hello')).toBe('echo: Hello');
    expect(await say(DIRECT, null, 'Hi')).toBe('echo: Hi');
    expect(await channelNotes()).toEqual({
      [GROCERIES_KEY]: 'data/System/Channels/Groceries.md',
      [KITCHEN_KEY]: 'data/System/Channels/Kitchen.md',
      [GENERAL_KEY]: 'data/System/Channels/Default.md',
      [DIRECT_KEY]: 'data/System/Channels/Default.md',
    });
    Object.assign(ids, await channelIds());
    const [, , general, direct] = await sessions();
    expect(general).toMatchObject({
      channelId: ids[GENERAL_KEY],
      agentName: 'default',
      status: 'active',
    });
    expect(direct).toMatchObject({
      channelId: ids[DIRECT_KEY],
      agentName: 'default',
      status: 'active',
    });
    expect(direct!.providerSessionId).not.toBe(general!.providerSessionId);

    // Each Channel's history is the text sent and received there.
    expect(await history(ids[GROCERIES_KEY]!)).toEqual([
      [
        'out',
        'pero',
        expect.stringMatching(/^Pero answers in this topic with claude, /),
      ],
      ['in', 'user', 'Milk'],
      ['out', 'agent', 'echo: Milk'],
      ['in', 'user', 'Eggs'],
      ['out', 'agent', 'echo: Eggs'],
    ]);
    expect(await history(ids[DIRECT_KEY]!)).toEqual([
      [
        'out',
        'pero',
        expect.stringMatching(/^Pero answers in this chat with claude, /),
      ],
      ['in', 'user', 'Hi'],
      ['out', 'agent', 'echo: Hi'],
    ]);

    // After a restart every Channel resumes its provider session.
    const beforeRestart = await sessions();
    await restart();
    expect(requests('claude')).toEqual([]);
    const resumed: [Chat, number | null, Session][] = [
      [FORUM, GROCERIES, groceries!],
      [FORUM, KITCHEN, kitchen!],
      [FORUM, null, general!],
      [DIRECT, null, direct!],
    ];
    for (const [chat, topic, session] of resumed) {
      const text = `Back ${session.id}`;
      expect(await say(chat, topic, text)).toBe(`echo: ${text}`);
      expect(lastRequest('claude')).toMatchObject({
        input: text,
        providerSessionId: session.providerSessionId,
      });
    }
    expect(
      (await sessions()).map(({ id, status, providerSessionId }) => ({
        id,
        status,
        providerSessionId,
      })),
    ).toEqual(
      beforeRestart.map(({ id, status, providerSessionId }) => ({
        id,
        status,
        providerSessionId,
      })),
    );

    // A new provider starts a fresh Session with the Channel's history.
    await note(
      'Groceries',
      [`channel-id: telegram:${GROCERIES_KEY}`, 'provider: codex'],
      'You shop.',
    );
    const carried = await say(FORUM, GROCERIES, 'Bread');
    const request = lastRequest('codex');
    expect(request.providerSessionId).toBeUndefined();
    expect(request.workingDirectory).toBe(workspace);
    expect(request.input).toMatch(/^\[Earlier conversation in this chat/);
    expect(request.input).toMatch(
      / User: Milk\n.* Pero: echo: Milk\n.* User: Back \d+\n.* Pero: echo: Back \d+\n/s,
    );
    expect(request.input).not.toMatch(/Soup|Hello|Pero answers in/);
    expect(request.input).toMatch(/\n\nBread$/);
    expect(carried).toBe(`echo: ${request.input}`);
    expect(
      (await sessions()).filter((s) => s.channelId === ids[GROCERIES_KEY]),
    ).toEqual([
      expect.objectContaining({ id: groceries!.id, status: 'closed' }),
      expect.objectContaining({
        status: 'active',
        provider: 'codex',
        providerSessionId: 'fake-codex-1',
      }),
    ]);

    // A Channel with its own folder works there; the other stays in the workspace.
    await note(
      'Kitchen',
      [`channel-id: telegram:${KITCHEN_KEY}`, `working-directory: ${other}`],
      'You cook.',
    );
    await say(FORUM, KITCHEN, 'Pan');
    const ownFolder = lastRequest('claude');
    expect(ownFolder.workingDirectory).toBe(other);
    expect(ownFolder.providerSessionId).toBeUndefined();
    expect(ownFolder.input).toMatch(
      /^\[Earlier conversation.* User: Soup\n.*\n\nPan$/s,
    );
    expect(await say(FORUM, GROCERIES, 'Jam')).toBe('echo: Jam');
    expect(lastRequest('codex')).toMatchObject({
      workingDirectory: workspace,
      providerSessionId: 'fake-codex-1',
    });

    // A new model continues the same conversation.
    await note('Default', ['model: claude-sonnet-5'], '');
    expect(await say(DIRECT, null, 'Again')).toBe('echo: Again');
    expect(lastRequest('claude')).toMatchObject({
      input: 'Again',
      providerSessionId: direct!.providerSessionId,
      providerOptions: { model: 'claude-sonnet-5' },
    });

    // Every message was answered exactly once, across the restart too.
    expect(
      api.sent().filter((payload) => String(payload.text).startsWith('echo: ')),
    ).toHaveLength(answers);
  }, 60_000);
});
