import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Chat, Message, User } from 'grammy/types';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { AllowedChatsService } from '../channels/allowed-chats.service.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { ComponentHealth } from '../health/component-health.js';
import { AllowedChat } from '../persistence/entities/allowed-chat.entity.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Message as HistoryMessage } from '../persistence/entities/message.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AGENT_RUNTIMES } from '../runtimes/agent-runtimes.js';
import { FakeAgentRuntime } from '../runtimes/testing/fake-agent-runtime.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { TelegramAdapter } from './telegram-adapter.js';
import { TelegramCredentials } from './telegram-credentials.service.js';
import { TelegramModule } from './telegram.module.js';
import { FakeBotApi, type UpdateBody } from './testing/fake-bot-api.js';

const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';
const OTHER = '987654321:BBEhBOweik6ad9r_QXMENQjcrGbqCr4K-xy';

const FORUM: Chat.SupergroupChat = {
  id: -1001234567890,
  type: 'supergroup',
  title: 'Household',
  is_forum: true,
};
const PLAIN_GROUP: Chat.GroupChat = {
  id: -4567,
  type: 'group',
  title: 'Family',
};
const DIRECT: Chat.PrivateChat = {
  id: 1234,
  type: 'private',
  first_name: 'Ada',
};
const OWNER: User = { id: 1234, is_bot: false, first_name: 'Ada' };

describe('TelegramAdapter', () => {
  let tmp: string;
  let secretsDir: string;
  let api: FakeBotApi;
  let runtime: FakeAgentRuntime;
  let moduleRef: TestingModule | undefined;
  let nextMessageId: number;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-telegram-'));
    secretsDir = join(tmp, 'secrets');
    mkdirSync(secretsDir, { mode: 0o700 });
    mkdirSync(join(tmp, 'vault'));
    api = new FakeBotApi();
    await api.listen();
    runtime = new FakeAgentRuntime('claude');
    nextMessageId = 1000;
  });

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Boots the Telegram path with the token in the environment by default. */
  async function start(
    options: { env?: NodeJS.ProcessEnv; allow?: Chat[] } = {},
  ) {
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: join(tmp, 'pero.sqlite') }),
        SettingsModule,
        AgentsModule,
        ChannelsModule,
        TelegramModule.forRoot({
          secretsDir,
          env: options.env ?? { PERO_TELEGRAM_BOT_TOKEN: TOKEN },
          apiRoot: api.url,
        }),
      ],
    })
      .overrideProvider(AGENT_RUNTIMES)
      .useValue([runtime])
      .compile();
    // The database opens during compilation; set up before intake starts.
    await moduleRef
      .get(SettingsService)
      .update({ defaultWorkingDirectory: join(tmp, 'vault') });
    for (const chat of options.allow ?? []) await allow(chat);
    await moduleRef.init();
  }

  function get<T>(token: new (...args: never[]) => T): T {
    return moduleRef!.get(token);
  }

  function db(): DataSource {
    return moduleRef!.get<DataSource>(getDataSourceToken());
  }

  function allow(chat: Chat) {
    return get(AllowedChatsService).allow({
      integrationKind: 'telegram',
      chatKey: String(chat.id),
      kind: chat.type === 'private' ? 'private' : 'group',
      title: 'title' in chat ? (chat.title ?? null) : null,
    });
  }

  function telegram() {
    return get(ComponentHealth)
      .list()
      .find((component) => component.name === 'telegram');
  }

  async function connected() {
    await vi.waitFor(() =>
      expect(telegram()).toMatchObject({
        state: 'ok',
        detail: 'Connected as @pero_test_bot',
      }),
    );
  }

  function message(chat: Chat, fields: Partial<Message> = {}): UpdateBody {
    return {
      message: {
        message_id: nextMessageId++,
        date: 0,
        chat,
        from: OWNER,
        text: 'Hi',
        ...fields,
      } as never,
    };
  }

  function inTopic(chat: Chat, topic: number, fields: Partial<Message> = {}) {
    return message(chat, {
      message_thread_id: topic,
      is_topic_message: true,
      ...fields,
    });
  }

  /** Waits until Telegram has been asked to send `count` messages. */
  async function sentCount(count: number) {
    await vi.waitFor(() => expect(api.sent()).toHaveLength(count));
    return api.sent();
  }

  describe('connecting', () => {
    it('polls for messages and membership changes and reports the bot', async () => {
      await start();

      await connected();

      expect(api.callsOf('getMe')[0]?.token).toBe(TOKEN);
      await vi.waitFor(() =>
        expect(api.callsOf('getUpdates')[0]?.payload).toMatchObject({
          allowed_updates: ['message', 'my_chat_member'],
        }),
      );
    });

    it('reports a rejected token without stopping', async () => {
      api.rejectToken(TOKEN);

      await start();

      await vi.waitFor(() =>
        expect(telegram()).toMatchObject({
          state: 'unconfigured',
          detail: 'Telegram rejected the bot token',
        }),
      );
      await expect(
        get(TelegramAdapter).send({ chatId: '1234' }, { text: 'Hi' }),
      ).rejects.toThrow();
    });

    it(
      'reports Telegram unreachable, then connected again',
      { timeout: 15_000 },
      async () => {
        await start();
        await connected();

        api.down();
        await vi.waitFor(() =>
          expect(telegram()).toMatchObject({
            state: 'degraded',
            detail: expect.stringMatching(/^Can't reach Telegram: /),
          }),
        );
        expect(JSON.stringify(telegram())).not.toContain(TOKEN);

        api.up();
        // grammY waits a few seconds before polling again, and a long poll
        // answers only once there is an update.
        api.push(
          message(FORUM, { from: { id: 9, is_bot: true, first_name: 'B' } }),
        );
        await vi.waitFor(connected, { timeout: 10_000 });
      },
    );

    it('reports another process polling the same bot, then tries again', async () => {
      api.failNext('getUpdates', {
        error_code: 409,
        description: 'Conflict: terminated by other getUpdates request',
      });

      await start();

      await vi.waitFor(() =>
        expect(telegram()).toMatchObject({
          state: 'degraded',
          detail: expect.stringContaining('Another process'),
        }),
      );
      await vi.waitFor(connected, { timeout: 5_000 });
    });

    it('follows a new token without a restart', async () => {
      await start({ env: {} });
      expect(telegram()).toMatchObject({ state: 'unconfigured' });

      get(TelegramCredentials).set(TOKEN);
      await connected();
      get(TelegramCredentials).set(OTHER);

      await vi.waitFor(() =>
        expect(api.callsOf('getUpdates').at(-1)?.token).toBe(OTHER),
      );
      await connected();

      get(TelegramCredentials).set(null);
      await vi.waitFor(() =>
        expect(telegram()).toMatchObject({
          state: 'unconfigured',
          detail: 'Bot token is not set',
        }),
      );
    });
  });

  describe('addresses', () => {
    it('answers a forum topic in that topic', async () => {
      await start({ allow: [FORUM] });

      api.push(inTopic(FORUM, 42, { text: 'Hello' }));

      const [welcome, reply] = await sentCount(2);
      for (const sent of [welcome, reply]) {
        expect(sent).toMatchObject({
          chat_id: '-1001234567890',
          message_thread_id: 42,
        });
      }
      expect(welcome?.text).toMatch(/^This topic talks to Agent topic-42/);
      expect(reply?.text).toBe('echo: Hello');
    });

    it('answers the General topic, a group without topics, and a direct chat without a thread', async () => {
      await start({ allow: [FORUM, PLAIN_GROUP, DIRECT] });

      api.push(message(FORUM, { text: 'General' }));
      await sentCount(2);
      // A reply thread in a group without topics is not a topic.
      api.push(message(PLAIN_GROUP, { text: 'Plain', message_thread_id: 9 }));
      await sentCount(4);
      api.push(message(DIRECT, { text: 'Direct' }));
      const sent = await sentCount(6);

      expect(
        sent.map(({ chat_id, text, message_thread_id }) => ({
          chat_id,
          text,
          message_thread_id,
        })),
      ).toEqual([
        expect.objectContaining({ chat_id: '-1001234567890' }),
        {
          chat_id: '-1001234567890',
          text: 'echo: General',
          message_thread_id: undefined,
        },
        expect.objectContaining({ chat_id: '-4567' }),
        { chat_id: '-4567', text: 'echo: Plain', message_thread_id: undefined },
        expect.objectContaining({ chat_id: '1234' }),
        { chat_id: '1234', text: 'echo: Direct', message_thread_id: undefined },
      ]);
      const keys = (await db().getRepository(Channel).find()).map(
        (channel) => channel.externalKey,
      );
      expect(keys.sort()).toEqual(['-1001234567890', '-4567', '1234']);
    });

    it('onboards a created topic once and follows its rename', async () => {
      await start({ allow: [FORUM] });

      api.push(
        inTopic(FORUM, 42, {
          message_id: 42,
          text: undefined,
          forum_topic_created: { name: 'Health', icon_color: 0 },
        }),
      );
      api.push(inTopic(FORUM, 42, { text: 'Hi' }));
      await sentCount(2);
      api.push(
        inTopic(FORUM, 42, {
          text: undefined,
          forum_topic_edited: { name: 'Fitness' },
        }),
      );

      await vi.waitFor(async () => {
        const channels = await db()
          .getRepository(Channel)
          .find({ relations: { agent: true } });
        expect(channels).toHaveLength(1);
        expect(channels[0]).toMatchObject({
          externalKey: '-1001234567890:42',
          title: 'Fitness',
          agent: { name: 'health', title: 'Fitness' },
        });
      });
    });

    it('never answers another bot', async () => {
      await start({ allow: [FORUM] });
      await connected();

      api.push(
        message(FORUM, {
          from: { id: 999, is_bot: true, first_name: 'Other' },
          text: 'Beep',
        }),
      );
      api.push(message(FORUM, { text: 'After' }));

      const sent = await sentCount(2);
      expect(sent[1]?.text).toBe('echo: After');
      expect(runtime.requests.map((request) => request.input)).toEqual([
        'After',
      ]);
    });
  });

  describe('chat migration', () => {
    it('moves the allowlist entry and Channel to the new chat ID', async () => {
      const supergroup: Chat.SupergroupChat = {
        id: -1009876543210,
        type: 'supergroup',
        title: 'Family',
      };
      await start({ allow: [PLAIN_GROUP] });
      api.push(message(PLAIN_GROUP, { text: 'Before' }));
      await sentCount(2);
      const [before] = await db().getRepository(Channel).find();

      api.push(
        message(PLAIN_GROUP, {
          text: undefined,
          migrate_to_chat_id: supergroup.id,
        }),
      );
      api.push(
        message(supergroup, {
          text: undefined,
          migrate_from_chat_id: PLAIN_GROUP.id,
        }),
      );
      api.push(message(supergroup, { text: 'After' }));

      const sent = await sentCount(3);
      expect(sent[2]).toMatchObject({
        chat_id: '-1009876543210',
        text: 'echo: After',
      });
      expect(
        (await db().getRepository(AllowedChat).find()).map((c) => c.chatKey),
      ).toEqual(['-1009876543210']);
      expect(await db().getRepository(Channel).find()).toEqual([
        expect.objectContaining({
          id: before!.id,
          externalKey: '-1009876543210',
          address: { chatId: '-1009876543210' },
        }),
      ]);
      // The same conversation continues.
      expect(runtime.requests.at(-1)?.providerSessionId).toBe('fake-claude-1');
    });

    it('sends to the new chat ID when Telegram says the chat moved', async () => {
      await start();
      await connected();
      api.migrated.set('-4567', -1009876543210);

      await get(TelegramAdapter).send({ chatId: '-4567' }, { text: 'Hi' });

      expect(api.sent().map((sent) => sent.chat_id)).toEqual([
        '-4567',
        '-1009876543210',
      ]);
    });
  });

  describe('administrator check', () => {
    it('flags an allowed group where the bot is only a member, until it is promoted', async () => {
      api.memberStatus.set(String(FORUM.id), 'member');

      await start({ allow: [FORUM] });

      await vi.waitFor(() =>
        expect(telegram()).toMatchObject({
          state: 'degraded',
          detail:
            "Connected as @pero_test_bot; the bot isn't an administrator of " +
            'Household (-1001234567890), so Telegram shows it only commands, ' +
            'mentions, and replies: make it an administrator, or turn off ' +
            'privacy mode with @BotFather /setprivacy',
        }),
      );

      api.push({
        my_chat_member: {
          chat: FORUM,
          from: OWNER,
          date: 0,
          old_chat_member: { status: 'member', user: api.me },
          new_chat_member: {
            status: 'administrator',
            user: api.me,
          } as never,
        },
      });

      await connected();
    });

    it('accepts a member when privacy mode is off', async () => {
      api.memberStatus.set(String(FORUM.id), 'member');
      api.me = { ...api.me, can_read_all_group_messages: true };

      await start({ allow: [FORUM] });

      await connected();
      await vi.waitFor(() =>
        expect(api.callsOf('getChatMember')).toHaveLength(1),
      );
      expect(telegram()?.state).toBe('ok');
    });

    it('flags a group the bot has left', async () => {
      await start({ allow: [FORUM] });
      await connected();

      api.push({
        my_chat_member: {
          chat: FORUM,
          from: OWNER,
          date: 0,
          old_chat_member: { status: 'administrator', user: api.me } as never,
          new_chat_member: { status: 'left', user: api.me },
        },
      });

      await vi.waitFor(() =>
        expect(telegram()?.detail).toContain(
          "the bot isn't in Household (-1001234567890)",
        ),
      );
    });
  });

  describe('sending', () => {
    it('waits out the flood limit', async () => {
      await start();
      await connected();
      api.failNext('sendMessage', {
        error_code: 429,
        description: 'Too Many Requests: retry after 0',
        parameters: { retry_after: 0 },
      });

      const sent = await get(TelegramAdapter).send(
        { chatId: '1234' },
        { text: 'Hi' },
      );

      expect(api.sent()).toHaveLength(2);
      expect(sent.messageId).toBe('1');
    });

    it('splits a long reply and records it once', async () => {
      await start({ allow: [DIRECT] });
      const long = Array.from({ length: 1000 }, () => 'word').join(' ');

      api.push(message(DIRECT, { text: long }));

      const sent = await sentCount(3);
      expect(
        sent
          .slice(1)
          .map((part) => part.text)
          .join(''),
      ).toBe(`echo: ${long}`);
      await vi.waitFor(async () =>
        expect(
          await db().getRepository(HistoryMessage).findBy({ origin: 'agent' }),
        ).toEqual([
          expect.objectContaining({
            text: `echo: ${long}`,
            externalMessageId: String(2),
          }),
        ]),
      );
    });
  });
});
