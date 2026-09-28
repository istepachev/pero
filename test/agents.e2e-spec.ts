import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Chat, Message, User } from 'grammy/types';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import {
  type ControlClient,
  createControlClient,
} from '../src/control/client.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';
import { Session } from '../src/persistence/entities/session.entity.js';
import {
  FakeBotApi,
  type UpdateBody,
} from '../src/telegram/testing/fake-bot-api.js';

const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';

const FORUM: Chat.SupergroupChat = {
  id: -1001234567890,
  type: 'supergroup',
  title: 'Household',
  is_forum: true,
};
const OWNER: User = { id: 1234, is_bot: false, first_name: 'Ada' };
const TOPIC = 42;

describe('Agent management (e2e)', () => {
  let tmp: string;
  let vault: string;
  let other: string;
  let dataDir: string;
  let client: ControlClient;
  let daemon: Daemon | undefined;
  let api: FakeBotApi;
  let nextMessageId: number;

  beforeEach(async () => {
    api = new FakeBotApi();
    api.chats.set(String(FORUM.id), FORUM);
    await api.listen();
    // Short: macOS limits socket paths to 104 bytes.
    tmp = mkdtempSync(join(tmpdir(), 'pero-'));
    dataDir = join(tmp, 'pero');
    vault = join(tmp, 'vault');
    other = join(tmp, 'other');
    mkdirSync(vault);
    mkdirSync(other);
    client = createControlClient(join(dataDir, 'run', 'pero.sock'));
    nextMessageId = 1;
  });

  afterEach(async () => {
    await daemon?.stop('test finished');
    daemon = undefined;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A daemon serving the forum group, whose Agents answer with an echo. */
  async function start() {
    daemon = await startDaemon({
      config: resolveBootstrapConfig({ dataDir, env: {} }),
      foreground: false,
      env: { PERO_TELEGRAM_API_ROOT: api.url, PERO_FAKE_RUNTIME: 'echo' },
    });
    await client.call('settings.update', {
      defaultWorkingDirectory: vault,
      telegramBotToken: TOKEN,
    });
    await vi.waitFor(async () =>
      expect((await client.call('telegram.chats')).bot).toBe('pero_test_bot'),
    );
    await client.call('telegram.allow', { chatId: String(FORUM.id) });
  }

  function sessions(): Promise<Session[]> {
    return daemon!.app
      .get<DataSource>(getDataSourceToken())
      .getRepository(Session)
      .find({ order: { id: 'ASC' } });
  }

  /** A message in the topic; resolves to its update ID. */
  function inTopic(fields: Partial<Message>): number {
    return api.push({
      message: {
        message_id: nextMessageId++,
        date: 0,
        chat: FORUM,
        from: OWNER,
        message_thread_id: TOPIC,
        is_topic_message: true,
        ...fields,
      } as never,
    } satisfies UpdateBody);
  }

  /** Sends `text` in the topic and resolves to the Agent's answer. */
  async function say(text: string): Promise<string> {
    const before = api.sent().length;
    inTopic({ text });
    await vi.waitFor(() => expect(api.sent()).toHaveLength(before + 1));
    return String(api.sent().at(-1)!.text);
  }

  async function nextTurn() {
    const agent = await client.call('agents.get', { name: 'groceries' });
    return agent.channels[0]!.nextTurn;
  }

  it('resumes a Session after a model edit and starts a fresh one after a provider or folder edit', async () => {
    await start();
    inTopic({
      text: undefined,
      forum_topic_created: { name: 'Groceries', icon_color: 0 },
    });
    await vi.waitFor(() => expect(api.sent()).toHaveLength(1));
    expect(String(api.sent()[0]!.text)).toMatch(
      /^This topic talks to Agent groceries/,
    );
    expect(await nextTurn()).toMatchObject({ kind: 'new', carriesOver: false });

    expect(await say('Milk')).toBe('echo: Milk');
    const [first] = await sessions();
    expect(first).toMatchObject({
      provider: 'claude',
      providerSessionId: 'fake-claude-1',
    });

    // Model and effort change within the Session.
    await client.call('agents.edit', {
      name: 'groceries',
      change: { providerOptions: { model: 'claude-sonnet-5', effort: 'high' } },
    });
    expect(await nextTurn()).toEqual({
      kind: 'resume',
      reason: null,
      from: null,
      sessionId: first!.id,
      carriesOver: false,
    });
    expect(await say('Eggs')).toBe('echo: Eggs');
    expect(await sessions()).toEqual([
      expect.objectContaining({
        id: first!.id,
        status: 'active',
        providerSessionId: 'fake-claude-1',
      }),
    ]);

    // A new provider starts a fresh Session with the recent messages.
    const edited = await client.call('agents.edit', {
      name: 'groceries',
      change: { provider: 'codex' },
    });
    expect(edited).toMatchObject({ provider: 'codex', model: null });
    expect(await nextTurn()).toEqual({
      kind: 'fresh',
      reason: 'provider',
      from: 'claude',
      sessionId: first!.id,
      carriesOver: true,
    });
    const carried = await say('Bread');
    expect(carried).toMatch(/^echo: \[Earlier conversation in this chat/);
    expect(carried).toMatch(/ User: Milk\n.* groceries: echo: Eggs\n/s);
    expect(carried).toMatch(/\n\nBread$/);
    const afterProvider = await sessions();
    expect(afterProvider).toEqual([
      expect.objectContaining({ id: first!.id, status: 'closed' }),
      expect.objectContaining({
        status: 'active',
        provider: 'codex',
        workingDirectory: vault,
        providerSessionId: 'fake-codex-1',
      }),
    ]);

    // So does a new folder.
    await client.call('agents.edit', {
      name: 'groceries',
      change: { workingDirectory: other },
    });
    expect(await nextTurn()).toMatchObject({
      kind: 'fresh',
      reason: 'folder',
      from: vault,
      carriesOver: true,
    });
    expect(await say('Butter')).toMatch(
      /^echo: \[Earlier conversation.*User: Bread.*\n\nButter$/s,
    );
    expect((await sessions()).at(-1)).toMatchObject({
      status: 'active',
      provider: 'codex',
      workingDirectory: other,
      providerSessionId: 'fake-codex-2',
    });
  });

  it('keeps a disabled Agent silent, and health off its provider, until it is enabled', async () => {
    await start();
    inTopic({
      text: undefined,
      forum_topic_created: { name: 'Groceries', icon_color: 0 },
    });
    await vi.waitFor(() => expect(api.sent()).toHaveLength(1));
    await client.call('agents.edit', {
      name: 'groceries',
      change: { provider: 'codex' },
    });
    const codex = async () =>
      (await client.status()).components.find((c) => c.name === 'codex');
    expect(await codex()).toMatchObject({ required: true });

    await client.call('agents.edit', {
      name: 'groceries',
      change: { enabled: false },
    });
    expect(await codex()).toMatchObject({ required: false });
    const ignored = inTopic({ text: 'Anyone?' });
    // Handled once the next poll confirms it, with no answer.
    await vi.waitFor(() =>
      expect(
        api
          .callsOf('getUpdates')
          .some((call) => Number(call.payload.offset) > ignored),
      ).toBe(true),
    );
    expect(api.sent()).toHaveLength(1);

    await client.call('agents.edit', {
      name: 'groceries',
      change: { enabled: true },
    });
    expect(await codex()).toMatchObject({ required: true });
    expect(await say('Tea')).toMatch(/^echo: .*Tea$/s);
  });
});
