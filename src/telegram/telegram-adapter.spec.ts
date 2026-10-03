import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Chat, Message, User } from 'grammy/types';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { AllowedChatsService } from '../channels/allowed-chats.service.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { COMMANDS } from '../channels/commands/command-list.js';
import { ComponentHealth } from '../health/component-health.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Message as HistoryMessage } from '../persistence/entities/message.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AGENT_RUNTIMES } from '../runtimes/agent-runtimes.js';
import { SpeechService } from '../speech/speech.service.js';
import { FakeSpeech } from '../speech/testing/fake-speech.js';
import { FakeAgentRuntime } from '../runtimes/testing/fake-agent-runtime.js';
import { TestWorkspace } from '../system/testing/test-workspace.js';
import { MEDIA_GROUP_WAIT_MS } from './media-groups.js';
import { TelegramAdapter } from './telegram-adapter.js';
import { TelegramCredentials } from './telegram-credentials.service.js';
import { TelegramStatus } from './telegram-status.js';
import { TelegramModule } from './telegram.module.js';
import {
  FakeBotApi,
  type FakeUpload,
  type UpdateBody,
} from './testing/fake-bot-api.js';

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
  let ws: TestWorkspace;
  let api: FakeBotApi;
  let runtime: FakeAgentRuntime;
  let speech: FakeSpeech;
  let moduleRef: TestingModule | undefined;
  let nextMessageId: number;

  beforeEach(async () => {
    ws = TestWorkspace.create('pero-telegram-');
    await ws.channel('Default');
    api = new FakeBotApi();
    await api.listen();
    runtime = new FakeAgentRuntime('claude');
    speech = new FakeSpeech();
    nextMessageId = 1000;
  });

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
    await api.close();
    ws.delete();
  });

  /**
   * Boots the Telegram path with the token in the environment and the
   * direct chat allowed by default.
   */
  async function start(
    options: { env?: NodeJS.ProcessEnv; allow?: Chat[] } = {},
  ) {
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: ws.database }),
        ws.hostConfig(),
        AgentsModule,
        ChannelsModule,
        TelegramModule.forRoot({
          envFile: ws.envFile,
          gitignore: ws.gitignore,
          env: options.env ?? { PERO_TELEGRAM_BOT_TOKEN: TOKEN },
          apiRoot: api.url,
        }),
      ],
    })
      .overrideProvider(AGENT_RUNTIMES)
      .useValue([runtime])
      .overrideProvider(SpeechService)
      .useValue(speech)
      .compile();
    // The database opens during compilation; set up before intake starts.
    for (const chat of options.allow ?? [DIRECT]) await allow(chat);
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
          allowed_updates: ['message', 'my_chat_member', 'callback_query'],
        }),
      );
    });

    it("lists Pero's commands in Telegram's command menu", async () => {
      await start();
      await connected();

      await vi.waitFor(() =>
        expect(api.callsOf('setMyCommands')[0]?.payload).toEqual({
          commands: COMMANDS.map(({ name, description }) => ({
            command: name,
            description,
          })),
        }),
      );
    });

    it('reports Telegram degraded while no chat is allowed', async () => {
      await start({ allow: [] });

      await vi.waitFor(() =>
        expect(telegram()).toMatchObject({
          state: 'degraded',
          detail:
            'Connected as @pero_test_bot; no chat is allowed yet: add the ' +
            'bot to a group or message it, then pero telegram allow <chat-id>',
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
    });
  });

  describe('addresses', () => {
    it('answers a forum topic in that topic', async () => {
      await start({ allow: [FORUM] });

      api.push(
        inTopic(FORUM, 42, {
          text: undefined,
          forum_topic_created: { name: 'Health', icon_color: 0 },
        }),
      );
      api.push(inTopic(FORUM, 42, { text: 'Hello' }));

      const [welcome, reply] = await sentCount(2);
      for (const sent of [welcome, reply]) {
        expect(sent).toMatchObject({
          chat_id: '-1001234567890',
          message_thread_id: 42,
        });
      }
      expect(welcome?.text).toMatch(/^Pero answers in this topic with claude/);
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
        const channels = await db().getRepository(Channel).find();
        expect(channels).toHaveLength(1);
        expect(channels[0]).toMatchObject({
          externalKey: '-1001234567890:42',
          title: 'Fitness',
        });
        // The note keeps its name and stays bound to the topic.
        expect(ws.read('Channels/Health.md')).toContain(
          'channel-id: telegram:-1001234567890:42',
        );
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

  describe('commands', () => {
    it('answers a command itself, and one for another bot not at all, without a turn', async () => {
      await start({ allow: [FORUM] });
      await connected();

      api.push(
        message(FORUM, {
          text: '/status@other_bot',
          entities: [{ type: 'bot_command', offset: 0, length: 17 }],
        }),
      );
      api.push(
        message(FORUM, {
          text: '/status@pero_test_bot',
          entities: [{ type: 'bot_command', offset: 0, length: 21 }],
        }),
      );

      const sent = await sentCount(2);
      expect(sent[1]?.text).toMatch(/^Channel Household\nState: idle/);
      expect(sent[1]?.reply_markup).toMatchObject({
        inline_keyboard: [
          [{ callback_data: '/new ask' }, { callback_data: '/status' }],
          [{ callback_data: '/model' }, { callback_data: '/effort' }],
        ],
      });
      expect(runtime.requests).toEqual([]);
      expect(api.callsOf('setMessageReaction')).toEqual([]);
    });

    it('passes a command Pero does not know on as a message', async () => {
      await start({ allow: [FORUM] });
      await connected();

      api.push(
        message(FORUM, {
          text: '/plan the week',
          entities: [{ type: 'bot_command', offset: 0, length: 5 }],
        }),
      );

      const sent = await sentCount(2);
      expect(sent[1]?.text).toBe('echo: /plan the week');
    });

    it("edits a command's menu in place when its button is pressed", async () => {
      await start({ allow: [FORUM] });
      await connected();
      api.push(
        message(FORUM, {
          text: '/help',
          entities: [{ type: 'bot_command', offset: 0, length: 5 }],
        }),
      );
      const [, help] = await sentCount(2);

      api.push({
        callback_query: {
          id: 'query-9',
          from: OWNER,
          chat_instance: 'instance',
          data: '/new ask',
          message: {
            message_id: 5555,
            date: 1,
            chat: FORUM,
            text: help!.text,
          },
        } as never,
      });

      await vi.waitFor(() =>
        expect(api.callsOf('editMessageText')[0]?.payload).toMatchObject({
          message_id: 5555,
          text: expect.stringMatching(/^Start over here\?/),
        }),
      );
      expect(api.sent()).toHaveLength(2);
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
        (await get(AllowedChatsService).list('telegram')).map((c) => c.chatKey),
      ).toEqual(['-1009876543210']);
      expect(
        readFileSync(join(ws.stateFolder, 'config.yaml'), 'utf8'),
      ).toContain('- id: -1009876543210\n');
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

    it('records whether an allowed group has topics', async () => {
      api.chats.set(String(FORUM.id), FORUM);
      api.chats.set(String(PLAIN_GROUP.id), PLAIN_GROUP);
      const topics = (chat: Chat) =>
        get(TelegramStatus)
          .access()
          .find((access) => access.chatKey === String(chat.id))?.topics;

      await start({ allow: [FORUM, PLAIN_GROUP] });

      await vi.waitFor(() => {
        expect(topics(FORUM)).toBe(true);
        expect(topics(PLAIN_GROUP)).toBe(false);
      });

      // Topics turned on without a new chat ID show in their first topic.
      api.push(
        inTopic(PLAIN_GROUP, 7, {
          text: undefined,
          forum_topic_created: { name: 'Plans', icon_color: 0 },
        }),
      );
      await vi.waitFor(() => expect(topics(PLAIN_GROUP)).toBe(true));
    });

    it('fills in the name of a group allowed by its ID alone', async () => {
      api.chats.set(String(FORUM.id), FORUM);

      await start({ allow: [{ ...FORUM, title: undefined } as never] });

      await vi.waitFor(async () =>
        expect(
          await get(AllowedChatsService).find('telegram', String(FORUM.id)),
        ).toMatchObject({ title: 'Household' }),
      );
    });

    it('flags a group the bot has left', async () => {
      await start({ allow: [FORUM] });
      await connected();
      // The check at connection must not answer after the event does.
      await vi.waitFor(() =>
        expect(get(TelegramStatus).access()).toHaveLength(1),
      );

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

  describe('buttons', () => {
    it('sends button rows as an inline keyboard and edits them away', async () => {
      await start();
      await connected();
      const adapter = get(TelegramAdapter);

      const sent = await adapter.send(
        { chatId: '1234' },
        {
          text: 'Allow?',
          buttons: [
            [
              { id: 'abc:allow', label: 'Allow' },
              { id: 'abc:deny', label: 'Deny' },
            ],
            [{ id: '/help', label: 'Help' }],
          ],
        },
      );
      await adapter.edit({ chatId: '1234' }, sent.messageId, {
        text: 'Allow?\n\n✅ Allowed by @ada',
      });

      expect(api.sent().at(-1)).toMatchObject({
        text: 'Allow?',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Allow', callback_data: 'abc:allow' },
              { text: 'Deny', callback_data: 'abc:deny' },
            ],
            [{ text: 'Help', callback_data: '/help' }],
          ],
        },
      });
      expect(api.callsOf('editMessageText')[0]?.payload).toMatchObject({
        chat_id: '1234',
        message_id: Number(sent.messageId),
        text: 'Allow?\n\n✅ Allowed by @ada',
        reply_markup: { inline_keyboard: [] },
      });
    });

    it('refuses a button ID Telegram cannot carry', async () => {
      await start();
      await connected();

      await expect(
        get(TelegramAdapter).send(
          { chatId: '1234' },
          { text: 'Hi', buttons: [[{ id: 'x'.repeat(65), label: 'Go' }]] },
        ),
      ).rejects.toThrow(/longer than 64 bytes/);
    });

    it("answers a press, showing the presser Pero's notice", async () => {
      await start();
      await connected();

      api.push({
        callback_query: {
          id: 'query-7',
          from: OWNER,
          chat_instance: 'instance',
          data: 'gone:allow',
          message: {
            message_id: 5,
            date: 1,
            chat: DIRECT,
            text: 'Allow?',
          } as never,
        },
      });

      await vi.waitFor(() =>
        expect(api.callsOf('answerCallbackQuery')[0]?.payload).toEqual({
          callback_query_id: 'query-7',
          text: 'This request has expired',
        }),
      );
    });
  });

  describe('files', () => {
    const photo = (fileId: string) => [
      {
        file_id: `${fileId}-small`,
        file_unique_id: 's',
        width: 90,
        height: 60,
      },
      { file_id: fileId, file_unique_id: 'l', width: 1280, height: 853 },
    ];

    it('saves a photo and shows it to the turn with its caption', async () => {
      await start();
      api.files.set('receipt', new Uint8Array([0xff, 0xd8, 0xff]));

      api.push(
        message(DIRECT, {
          text: undefined,
          photo: photo('receipt'),
          caption: 'How much was it?',
        }),
      );

      await sentCount(2);
      const [request] = runtime.requests;
      const [path] = request!.attachments!;
      expect(path).toMatch(
        new RegExp(`^${join(ws.stateFolder, 'attachments')}/\\d+/.+\\.jpg$`),
      );
      expect([...readFileSync(path!)]).toEqual([0xff, 0xd8, 0xff]);
      expect(request!.input).toBe(
        `[Image attached, saved at ${path}]\nHow much was it?`,
      );
      expect(api.callsOf('download')[0]!.token).toBe(TOKEN);
    });

    it('answers an album once, with all its photos', async () => {
      await start();
      api.files.set('left', new Uint8Array([1]));
      api.files.set('right', new Uint8Array([2]));

      for (const [fileId, caption] of [
        ['left', 'Which is better?'],
        ['right', undefined],
      ] as const) {
        api.push(
          message(DIRECT, {
            text: undefined,
            photo: photo(fileId),
            media_group_id: 'album-1',
            ...(caption === undefined ? {} : { caption }),
          }),
        );
      }

      // The album waits for more parts first.
      await vi.waitFor(() => expect(api.sent()).toHaveLength(2), {
        timeout: MEDIA_GROUP_WAIT_MS + 2_000,
      });
      expect(runtime.requests).toHaveLength(1);
      const { attachments, input } = runtime.requests[0]!;
      expect(attachments!.map((path) => [...readFileSync(path)])).toEqual([
        [1],
        [2],
      ]);
      expect(input).toBe(
        `[Image attached, saved at ${attachments![0]}]\n` +
          `[Image attached, saved at ${attachments![1]}]\n` +
          'Which is better?',
      );
    });

    it('saves a file under its name and names it to the turn', async () => {
      await start();
      api.files.set('report', new Uint8Array([0x25, 0x50, 0x44, 0x46]));

      api.push(
        message(DIRECT, {
          text: undefined,
          document: {
            file_id: 'report',
            file_unique_id: 'r',
            file_name: 'Q3 report.pdf',
            mime_type: 'application/pdf',
          },
          caption: 'Sum it up',
        }),
      );

      await sentCount(2);
      const [request] = runtime.requests;
      const [path] = request!.attachments!;
      expect(path).toMatch(
        new RegExp(
          `^${join(ws.stateFolder, 'attachments')}/\\d+/.+-Q3_report\\.pdf$`,
        ),
      );
      expect([...readFileSync(path!)]).toEqual([0x25, 0x50, 0x44, 0x46]);
      expect(request!.input).toBe(
        `[File attached: Q3 report.pdf, saved at ${path}]\nSum it up`,
      );
    });

    it('answers a voice message as its transcript', async () => {
      await start();
      api.files.set('voice', new TextEncoder().encode('Remind me at ten.'));

      api.push(
        message(DIRECT, {
          text: undefined,
          voice: {
            file_id: 'voice',
            file_unique_id: 'v',
            duration: 3,
            mime_type: 'audio/ogg',
          },
        }),
      );

      await sentCount(2);
      const [request] = runtime.requests;
      const [file] = speech.transcribed;
      expect(file!.path).toMatch(
        new RegExp(`^${join(ws.stateFolder, 'attachments')}/\\d+/.+\\.ogg$`),
      );
      expect(request!.input).toBe(
        `[Voice message, 0:03, saved at ${file!.path}. Transcript:]\n` +
          'Remind me at ten.',
      );
      // No model hears the recording itself.
      expect(request!.attachments).toBeUndefined();
    });

    it('says why a voice message was not transcribed, and runs no turn', async () => {
      await start();
      speech.transcribeFails = "whisper-cli isn't installed; run pero speech";
      api.files.set('voice', new Uint8Array([1]));

      api.push(
        message(DIRECT, {
          text: undefined,
          voice: { file_id: 'voice', file_unique_id: 'v', duration: 3 },
        }),
      );

      const [, notice] = await sentCount(2);
      expect(notice?.text).toBe(
        "Pero couldn't transcribe the voice message you sent (whisper-cli " +
          "isn't installed; run pero speech). Send it again, or write " +
          'it as text.',
      );
      expect(runtime.requests).toEqual([]);
    });

    it('says when Telegram has no file for a photo, and runs no turn', async () => {
      await start();

      api.push(message(DIRECT, { text: undefined, photo: photo('gone') }));

      const [, notice] = await sentCount(2);
      expect(notice?.text).toBe(
        "Pero couldn't get the image you sent (Bad Request: invalid " +
          'file_id). Send it again.',
      );
      expect(runtime.requests).toEqual([]);
    });

    it('fails a download without naming the token', async () => {
      await start();
      await connected();
      api.files.set('photo', new Uint8Array([1]));
      api.rejectToken(TOKEN);

      const failure = await get(TelegramAdapter)
        .download('photo')
        .catch((error: unknown) => error as Error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain(TOKEN);
    });
  });

  describe('voice messages', () => {
    it('sends a voice message, in its topic and with its length', async () => {
      await start();
      await connected();

      const sent = await get(TelegramAdapter).sendVoice(
        { chatId: '-1001234567890', messageThreadId: '5' },
        { audio: new Uint8Array([1, 2]), type: 'audio/ogg', durationS: 4 },
      );

      const [call] = api.callsOf('sendVoice');
      expect(sent.messageId).toMatch(/^\d+$/);
      expect(call!.payload).toMatchObject({
        chat_id: '-1001234567890',
        message_thread_id: '5',
        duration: '4',
      });
      const voice = call!.payload.voice as FakeUpload;
      expect(voice.name).toBe('voice.ogg');
      expect([...voice.bytes]).toEqual([1, 2]);
    });

    it('sends an audio file to someone who takes no voice messages', async () => {
      await start();
      await connected();
      api.failNext('sendVoice', {
        error_code: 400,
        description: 'Bad Request: VOICE_MESSAGES_FORBIDDEN',
      });

      await get(TelegramAdapter).sendVoice(
        { chatId: '1234' },
        { audio: new Uint8Array([3]), type: 'audio/mpeg', durationS: null },
      );

      const [call] = api.callsOf('sendAudio');
      expect(call!.payload).toMatchObject({ chat_id: '1234', title: 'Pero' });
      expect((call!.payload.audio as FakeUpload).name).toBe('voice.mp3');
    });

    it("records an answer's voice block and sends it between its text", async () => {
      await start();

      api.push(
        message(DIRECT, { text: 'Say <voice>Good morning.</voice> please' }),
      );

      await vi.waitFor(() => expect(api.callsOf('sendVoice')).toHaveLength(1));
      await vi.waitFor(() =>
        expect(api.sent().map((sent) => sent.text)).toContain('please'),
      );
      expect(speech.spoken).toEqual(['Good morning.']);
      expect(
        api.calls
          .filter((call) => /^send(Message|Voice)$/.test(call.method))
          .slice(-3)
          .map((call) => call.payload.text ?? call.method),
      ).toEqual(['echo: Say', 'sendVoice', 'please']);
    });
  });

  describe('working reaction', () => {
    it('reacts to a message while answering it, and clears the reaction after the answer', async () => {
      await start({ allow: [FORUM] });
      api.push(
        inTopic(FORUM, 42, {
          text: undefined,
          forum_topic_created: { name: 'Health', icon_color: 0 },
        }),
      );
      await sentCount(1);
      const held = runtime.hold();

      api.push(inTopic(FORUM, 42, { text: 'Hello' }));
      await held.started;

      await vi.waitFor(() =>
        expect(api.callsOf('setMessageReaction')[0]?.payload).toEqual({
          chat_id: '-1001234567890',
          message_id: nextMessageId - 1,
          reaction: [{ type: 'emoji', emoji: '👀' }],
        }),
      );

      held.release();
      await vi.waitFor(() =>
        expect(api.callsOf('setMessageReaction')).toHaveLength(2),
      );
      const methods = api.calls.map((call) => call.method);
      expect(methods.lastIndexOf('setMessageReaction')).toBeGreaterThan(
        methods.lastIndexOf('sendMessage'),
      );
      expect(api.callsOf('setMessageReaction')[1]?.payload).toEqual({
        chat_id: '-1001234567890',
        message_id: nextMessageId - 1,
        reaction: [],
      });
      expect(api.sent().at(-1)?.text).toBe('echo: Hello');
    });

    it('answers all the same in a chat that refuses the reaction', async () => {
      await start();
      await connected();
      api.failNext('setMessageReaction', {
        error_code: 400,
        description: 'Bad Request: REACTION_INVALID',
      });

      api.push(message(DIRECT, { text: 'Hello' }));

      // After the first steps a newly allowed chat gets.
      const [, reply] = await sentCount(2);
      expect(reply?.text).toBe('echo: Hello');
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

    it('says why Telegram could not be reached, without the token', async () => {
      await start();
      await connected();
      api.down();

      const failure = await get(TelegramAdapter)
        .send({ chatId: '1234' }, { text: 'Hi' })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(
        /^Telegram is unreachable: \S/,
      );
      expect((failure as Error).message).not.toContain(TOKEN);
      api.up();
    });

    it("shows an answer's Markdown as formatting, and Pero's own text as it is", async () => {
      await start();
      await connected();
      const adapter = get(TelegramAdapter);

      await adapter.send(
        { chatId: '1234' },
        { text: '**Done** for <you>', markdown: true },
      );
      await adapter.send({ chatId: '1234' }, { text: '**Status** <ok>' });

      expect(api.sent()).toEqual([
        expect.objectContaining({
          text: '<b>Done</b> for &lt;you&gt;',
          parse_mode: 'HTML',
        }),
        expect.not.objectContaining({ parse_mode: expect.anything() }),
      ]);
      expect(api.sent()[1]!.text).toBe('**Status** <ok>');
    });

    it('sends an answer as written when Telegram rejects its formatting', async () => {
      await start();
      await connected();
      api.failNext('sendMessage', {
        error_code: 400,
        description: "Bad Request: can't parse entities: unsupported tag",
      });

      await get(TelegramAdapter).send(
        { chatId: '1234' },
        { text: '**Done**', markdown: true },
      );

      expect(api.sent()).toEqual([
        expect.objectContaining({ text: '<b>Done</b>', parse_mode: 'HTML' }),
        expect.not.objectContaining({ parse_mode: expect.anything() }),
      ]);
      expect(api.sent()[1]!.text).toBe('**Done**');
    });

    it("names the chat of a topic's and a chat's address", async () => {
      await start();
      const adapter = get(TelegramAdapter);
      expect(
        adapter.chatKey({ chatId: '-1001234567890', messageThreadId: '7' }),
      ).toBe('-1001234567890');
      expect(adapter.chatKey({ chatId: '1234' })).toBe('1234');
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
