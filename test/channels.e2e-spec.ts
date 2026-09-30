import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Chat, Message, User } from 'grammy/types';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../src/common/errors.js';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import {
  type ControlClient,
  createControlClient,
} from '../src/control/client.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';
import { LegacyChannelAgent } from '../src/persistence/entities/legacy-channel-agent.entity.js';
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
const GROCERIES = 42;
const KITCHEN = 43;

describe('Channels of a legacy data directory (e2e)', () => {
  let tmp: string;
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
    mkdirSync(join(tmp, 'vault'));
    client = createControlClient(join(dataDir, 'run', 'pero.sock'));
    nextMessageId = 1;
  });

  afterEach(async () => {
    await daemon?.stop('test finished');
    daemon = undefined;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * A daemon serving the forum group, whose Agents answer with an echo,
   * with a Groceries and a Kitchen topic onboarded.
   */
  async function start() {
    daemon = await startDaemon({
      config: resolveBootstrapConfig({ dataDir, env: {} }),
      foreground: false,
      env: { PERO_TELEGRAM_API_ROOT: api.url, PERO_FAKE_RUNTIME: 'echo' },
    });
    await client.call('settings.update', {
      defaultWorkingDirectory: join(tmp, 'vault'),
      telegramBotToken: TOKEN,
    });
    await vi.waitFor(async () =>
      expect((await client.call('telegram.chats')).bot).toBe('pero_test_bot'),
    );
    await client.call('telegram.allow', { chatId: String(FORUM.id) });
    createTopic(GROCERIES, 'Groceries');
    createTopic(KITCHEN, 'Kitchen');
    await vi.waitFor(() => expect(api.sent()).toHaveLength(2));
  }

  function sessions(): Promise<Session[]> {
    return daemon!.app
      .get<DataSource>(getDataSourceToken())
      .getRepository(Session)
      .find({ order: { id: 'ASC' } });
  }

  /**
   * Changes Channel `id`'s Agent or state as a legacy data directory keeps
   * them, which no command changes any more.
   */
  async function route(
    id: number,
    change: { agentName?: string; enabled?: boolean },
  ): Promise<void> {
    await daemon!.app
      .get<DataSource>(getDataSourceToken())
      .getRepository(LegacyChannelAgent)
      .update(id, change);
  }

  /** A message in `topic`; resolves to its update ID. */
  function inTopic(topic: number, fields: Partial<Message>): number {
    return api.push({
      message: {
        message_id: nextMessageId++,
        date: 0,
        chat: FORUM,
        from: OWNER,
        message_thread_id: topic,
        is_topic_message: true,
        ...fields,
      } as never,
    } satisfies UpdateBody);
  }

  function createTopic(topic: number, name: string): number {
    return inTopic(topic, {
      text: undefined,
      forum_topic_created: { name, icon_color: 0 },
    });
  }

  /** Sends `text` in `topic` and resolves to the Agent's answer. */
  async function say(topic: number, text: string): Promise<string> {
    const before = api.sent().length;
    inTopic(topic, { text });
    await vi.waitFor(() => expect(api.sent()).toHaveLength(before + 1));
    const answer = api.sent().at(-1)!;
    expect(answer.message_thread_id).toBe(topic);
    return String(answer.text);
  }

  /** Waits until update `updateId` has been handled. */
  async function handled(updateId: number): Promise<void> {
    await vi.waitFor(() =>
      expect(
        api
          .callsOf('getUpdates')
          .some((call) => Number(call.payload.offset) > updateId),
      ).toBe(true),
    );
  }

  async function channelId(topic: number): Promise<number> {
    const { channels } = await client.call('channels.list');
    return channels.find((c) => c.key === `${FORUM.id}:${topic}`)!.id;
  }

  it('lists the Channels onboarding created, each with its Agent', async () => {
    await start();
    const { channels } = await client.call('channels.list');
    expect(channels).toEqual([
      expect.objectContaining({
        integrationKind: 'telegram',
        key: `${FORUM.id}:${GROCERIES}`,
        title: 'Groceries',
        agent: 'groceries',
        agentEnabled: true,
        unanswered: null,
      }),
      expect.objectContaining({
        key: `${FORUM.id}:${KITCHEN}`,
        title: 'Kitchen',
        agent: 'kitchen',
      }),
    ]);
    expect(
      await client.call('channels.get', { id: channels[0]!.id }),
    ).toMatchObject({
      agent: 'groceries',
      nextTurn: { kind: 'new', carriesOver: false },
      // The welcome.
      messages: 1,
    });
  });

  it("moves a Channel to another Agent, which starts with the Channel's history, keeping every Channel's Session separate", async () => {
    await start();
    const groceries = await channelId(GROCERIES);
    const kitchen = await channelId(KITCHEN);
    expect(await say(GROCERIES, 'Milk')).toBe('echo: Milk');
    expect(await say(KITCHEN, 'Soup')).toBe('echo: Soup');
    const [first, second] = await sessions();
    expect([first, second]).toEqual([
      expect.objectContaining({ channelId: groceries, status: 'active' }),
      expect.objectContaining({ channelId: kitchen, status: 'active' }),
    ]);
    expect(first).toMatchObject({ agentName: 'groceries' });
    expect(second).toMatchObject({ agentName: 'kitchen' });

    await route(groceries, { agentName: 'kitchen' });
    expect(await client.call('channels.get', { id: groceries })).toMatchObject({
      agent: 'kitchen',
      nextTurn: { kind: 'new', carriesOver: true },
    });
    expect(
      (await client.call('agents.get', { name: 'groceries' })).channels,
    ).toEqual([]);

    // The new Agent's first turn ends the old Agent's Session.
    const carried = await say(GROCERIES, 'Bread');
    expect(carried).toMatch(/^echo: \[Earlier conversation in this chat/);
    expect(carried).toMatch(/ User: Milk\n.* groceries: echo: Milk\n/s);
    expect(carried).not.toMatch(/Soup/);
    expect(carried).toMatch(/\n\nBread$/);

    // One Agent now, still a Session per Channel.
    expect(await say(KITCHEN, 'Stew')).toBe('echo: Stew');
    expect(await sessions()).toEqual([
      expect.objectContaining({ id: first!.id, status: 'closed' }),
      expect.objectContaining({
        id: second!.id,
        channelId: kitchen,
        agentName: 'kitchen',
        status: 'active',
      }),
      expect.objectContaining({
        channelId: groceries,
        agentName: 'kitchen',
        status: 'active',
      }),
    ]);
  });

  it('ignores a disabled Channel without onboarding it again, and resumes it once enabled', async () => {
    await start();
    const groceries = await channelId(GROCERIES);
    expect(await say(GROCERIES, 'Milk')).toBe('echo: Milk');
    const before = await sessions();

    await route(groceries, { enabled: false });
    expect(await client.call('channels.get', { id: groceries })).toMatchObject({
      agent: null,
      unanswered: 'the Channel is disabled',
    });
    const sent = api.sent().length;
    await handled(inTopic(GROCERIES, { text: 'Anyone?' }));
    // The topic created again, as a redelivered event would be.
    await handled(createTopic(GROCERIES, 'Groceries'));
    expect(api.sent()).toHaveLength(sent);
    expect(
      (await client.call('agents.list')).agents.map((agent) => agent.name),
    ).toEqual(['groceries', 'kitchen']);
    expect(
      (await client.call('channels.get', { id: groceries })).messages,
    ).toBe(3);

    await route(groceries, { enabled: true });
    expect(await say(GROCERIES, 'Eggs')).toBe('echo: Eggs');
    expect(await sessions()).toEqual(before);
  });

  it("prints a Channel's latest messages with direction and origin", async () => {
    await start();
    const groceries = await channelId(GROCERIES);
    await say(GROCERIES, 'Milk');
    await say(GROCERIES, 'Eggs');

    const all = await client.call('channels.history', { id: groceries });
    expect(all.channel).toMatchObject({ id: groceries, title: 'Groceries' });
    expect(
      all.messages.map(({ direction, origin, agent, text }) => [
        direction,
        origin,
        agent,
        text,
      ]),
    ).toEqual([
      [
        'out',
        'pero',
        null,
        expect.stringMatching(/^This topic talks to Agent groceries: /),
      ],
      ['in', 'user', 'groceries', 'Milk'],
      ['out', 'agent', 'groceries', 'echo: Milk'],
      ['in', 'user', 'groceries', 'Eggs'],
      ['out', 'agent', 'groceries', 'echo: Eggs'],
    ]);
    expect(all.messages[1]).toMatchObject({ senderId: String(OWNER.id) });

    const latest = await client.call('channels.history', {
      id: groceries,
      limit: 2,
    });
    expect(latest.messages.map((message) => message.text)).toEqual([
      'Eggs',
      'echo: Eggs',
    ]);
  });

  it('refuses an unknown Channel', async () => {
    await start();
    await expect(client.call('channels.get', { id: 99 })).rejects.toThrow(
      new NotFoundError('No Channel with ID 99'),
    );
    await expect(client.call('channels.history', { id: 99 })).rejects.toThrow(
      NotFoundError,
    );
  });
});
