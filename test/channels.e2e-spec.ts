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
import type { Chat, Message, User } from 'grammy/types';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../src/common/errors.js';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import { initWorkspace } from '../src/config/workspace-skeleton.js';
import {
  type ControlClient,
  createControlClient,
} from '../src/control/client.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';
import { Session } from '../src/persistence/entities/session.entity.js';
import { SystemNotes } from '../src/system/system-notes.service.js';
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
/** The `channel-id` of the topic `topic`. */
const bound = (topic: number) => `telegram:${FORUM.id}:${topic}`;

describe('Channels (e2e)', () => {
  let tmp: string;
  let workspace: string;
  let client: ControlClient;
  let daemon: Daemon | undefined;
  let api: FakeBotApi;
  let nextMessageId: number;
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
    clock = Date.parse('2026-01-01T00:00:00Z');
    write('Channels/Groceries.md', 'You shop.');
    write('Channels/Kitchen.md', 'You cook.');
    client = createControlClient(join(workspace, '.pero', 'run', 'pero.sock'));
    nextMessageId = 1;
  });

  afterEach(async () => {
    await daemon?.stop('test finished');
    daemon = undefined;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Writes `text` to the note at `file` in the system folder. */
  function write(file: string, text: string) {
    const path = join(workspace, 'data', 'System', file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    clock += 1_000;
    utimesSync(path, new Date(clock), new Date(clock));
  }

  /** Writes a note and has Pero read it, as its next scan would. */
  async function edit(file: string, text: string) {
    write(file, text);
    await daemon!.app.get(SystemNotes).rescan();
  }

  /**
   * A daemon serving the forum group, where Pero answers with an echo,
   * with a Groceries and a Kitchen topic onboarded, each bound to the
   * Channel note of its title.
   */
  async function start() {
    daemon = await startDaemon({
      config: resolveBootstrapConfig({ workspace, env: {} }),
      foreground: false,
      env: { PERO_TELEGRAM_API_ROOT: api.url, PERO_FAKE_RUNTIME: 'echo' },
    });
    await client.call('telegram.token', { token: TOKEN });
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

  /** Sends `text` in `topic` and resolves to Pero's answer. */
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

  it('lists the Channels onboarding created, each with the note it binds', async () => {
    await start();
    const { channels, unusedNotes } = await client.call('channels.list');
    expect(channels).toEqual([
      expect.objectContaining({
        integrationKind: 'telegram',
        key: `${FORUM.id}:${GROCERIES}`,
        title: 'Groceries',
        note: 'data/System/Channels/Groceries.md',
        unanswered: null,
      }),
      expect.objectContaining({
        key: `${FORUM.id}:${KITCHEN}`,
        title: 'Kitchen',
        note: 'data/System/Channels/Kitchen.md',
      }),
    ]);
    expect(unusedNotes).toEqual([]);
    expect(
      await client.call('channels.get', { id: channels[0]!.id }),
    ).toMatchObject({
      note: 'data/System/Channels/Groceries.md',
      settings: {
        name: 'groceries',
        file: 'data/System/Channels/Groceries.md',
        channelId: bound(GROCERIES),
        instructions: 'You shop.',
      },
      nextTurn: { kind: 'new', carriesOver: false },
      // The welcome.
      messages: 1,
    });
  });

  it("answers a Channel with the note its channel-id moves to, in the Channel's Session, keeping every Channel's Session separate", async () => {
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

    await edit('Channels/Groceries.md', 'You shop.');
    await edit(
      'Channels/Shopper.md',
      `---\nchannel-id: ${bound(GROCERIES)}\n---\nYou buy.`,
    );
    expect(await client.call('channels.get', { id: groceries })).toMatchObject({
      note: 'data/System/Channels/Shopper.md',
      settings: { name: 'shopper', instructions: 'You buy.' },
      nextTurn: { kind: 'resume', sessionId: first!.id, carriesOver: false },
    });
    expect((await client.call('channels.list')).unusedNotes).toEqual([
      { file: 'data/System/Channels/Groceries.md', channelId: null },
    ]);

    expect(await say(GROCERIES, 'Bread')).toBe('echo: Bread');

    // The other Channel keeps its note and Session.
    expect(await say(KITCHEN, 'Stew')).toBe('echo: Stew');
    expect(await sessions()).toEqual([
      expect.objectContaining({
        id: first!.id,
        channelId: groceries,
        status: 'active',
      }),
      expect.objectContaining({
        id: second!.id,
        channelId: kitchen,
        agentName: 'kitchen',
        status: 'active',
      }),
    ]);
  });

  it("silences a disabled Channel note's topic without onboarding it again, and resumes it once enabled", async () => {
    await start();
    const groceries = await channelId(GROCERIES);
    expect(await say(GROCERIES, 'Milk')).toBe('echo: Milk');
    const before = await sessions();

    await edit(
      'Channels/Groceries.md',
      `---\nchannel-id: ${bound(GROCERIES)}\nenabled: false\n---\nYou shop.`,
    );
    expect(await client.call('channels.get', { id: groceries })).toMatchObject({
      note: 'data/System/Channels/Groceries.md',
      unanswered: 'data/System/Channels/Groceries.md sets enabled: false',
    });
    // Once, saying why.
    expect(await say(GROCERIES, 'Anyone?')).toBe(
      "Pero doesn't answer here: data/System/Channels/Groceries.md sets " +
        'enabled: false. To turn it back on, set enabled: true there.',
    );
    const sent = api.sent().length;
    await handled(inTopic(GROCERIES, { text: 'Still?' }));
    // The topic created again, as a redelivered event would be.
    await handled(createTopic(GROCERIES, 'Groceries'));
    expect(api.sent()).toHaveLength(sent);

    await edit(
      'Channels/Groceries.md',
      `---\nchannel-id: ${bound(GROCERIES)}\n---\nYou shop.`,
    );
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
        expect.stringMatching(/^Pero answers in this topic with claude, /),
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
