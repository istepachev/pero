import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Chat, User } from 'grammy/types';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { AllowedChatsService } from '../channels/allowed-chats.service.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { NotFoundError } from '../common/errors.js';
import { ComponentHealth } from '../health/component-health.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Session } from '../persistence/entities/session.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AGENT_RUNTIMES } from '../runtimes/agent-runtimes.js';
import { FakeAgentRuntime } from '../runtimes/testing/fake-agent-runtime.js';
import { TestWorkspace } from '../settings/testing/test-workspace.js';
import { TelegramChats } from './telegram-chats.service.js';
import { TelegramModule } from './telegram.module.js';
import { FakeBotApi, type UpdateBody } from './testing/fake-bot-api.js';

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
  last_name: 'Lovelace',
};
const OWNER: User = { id: 1234, is_bot: false, first_name: 'Ada' };

describe('TelegramChats', () => {
  let ws: TestWorkspace;
  let api: FakeBotApi;
  let runtime: FakeAgentRuntime;
  let moduleRef: TestingModule | undefined;
  let nextMessageId: number;

  beforeEach(async () => {
    ws = TestWorkspace.create('pero-chats-');
    await ws.agent('Main');
    api = new FakeBotApi();
    await api.listen();
    runtime = new FakeAgentRuntime('claude');
    nextMessageId = 1000;
  });

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
    await api.close();
    ws.delete();
  });

  /** Boots the Telegram path, connected to the fake Bot API. */
  async function start() {
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: ws.database }),
        ws.hostConfig(),
        AgentsModule,
        ChannelsModule,
        TelegramModule.forRoot({
          envFile: ws.envFile,
          gitignore: ws.gitignore,
          env: { PERO_TELEGRAM_BOT_TOKEN: TOKEN },
          apiRoot: api.url,
        }),
      ],
    })
      .overrideProvider(AGENT_RUNTIMES)
      .useValue([runtime])
      .compile();
    await moduleRef.init();
    await vi.waitFor(() =>
      expect(telegram()?.detail).toMatch(/^Connected as @pero_test_bot/),
    );
  }

  /** The Agent notes, by file name. */
  function agentNotes(): string[] {
    return readdirSync(join(ws.settingsFolder, 'Agents')).sort();
  }

  function chats(): TelegramChats {
    return moduleRef!.get(TelegramChats);
  }

  function db(): DataSource {
    return moduleRef!.get<DataSource>(getDataSourceToken());
  }

  function telegram() {
    return moduleRef!
      .get(ComponentHealth)
      .list()
      .find((component) => component.name === 'telegram');
  }

  function message(chat: Chat, text: string): UpdateBody {
    return {
      message: {
        message_id: nextMessageId++,
        date: 0,
        chat,
        from: OWNER,
        text,
      } as never,
    };
  }

  /** Waits until Telegram has been asked to send `count` messages. */
  async function sentCount(count: number) {
    await vi.waitFor(() => expect(api.sent()).toHaveLength(count));
    return api.sent();
  }

  it('lists chats that asked to pair until they are allowed', async () => {
    await start();
    expect(await chats().list()).toEqual({
      bot: 'pero_test_bot',
      allowed: [],
      pairing: [],
    });

    api.push(message(FORUM, 'Hello?'));
    await sentCount(1);

    expect((await chats().list()).pairing).toEqual([
      {
        chatId: '-1001234567890',
        kind: 'group',
        title: 'Household',
        firstSeenAt: expect.any(String),
        lastSeenAt: expect.any(String),
      },
    ]);

    await chats().allow('-1001234567890');

    const list = await chats().list();
    expect(list.pairing).toEqual([]);
    expect(list.allowed).toEqual([
      {
        chatId: '-1001234567890',
        kind: 'group',
        title: 'Household',
        bot: 'administrator',
        topics: null,
        problem: null,
      },
    ]);
  });

  it('takes the kind and name from Telegram, then from the ID alone', async () => {
    api.chats.set(String(FORUM.id), FORUM);
    api.chats.set(String(DIRECT.id), DIRECT);
    await start();

    const forum = await chats().allow('-1001234567890');
    const direct = await chats().allow('1234');
    const unknownGroup = await chats().allow('-42');
    const unknownPerson = await chats().allow('42');

    expect(forum).toEqual({
      alreadyAllowed: false,
      chat: expect.objectContaining({
        kind: 'group',
        title: 'Household',
        bot: 'administrator',
        topics: true,
      }),
    });
    expect(direct.chat).toMatchObject({
      kind: 'private',
      title: 'Ada Lovelace',
      bot: null,
      topics: null,
    });
    expect(unknownGroup.chat).toMatchObject({ kind: 'group', title: null });
    expect(unknownPerson.chat).toMatchObject({ kind: 'private', title: null });
  });

  it('allows a chat again without changing it', async () => {
    await start();
    const first = await chats().allow('1234');

    const again = await chats().allow('1234');

    expect(again).toEqual({ alreadyAllowed: true, chat: first.chat });
    expect(
      await moduleRef!.get(AllowedChatsService).list('telegram'),
    ).toHaveLength(1);
  });

  it('keeps Telegram degraded until a chat is allowed, and after the last is denied', async () => {
    await start();
    expect(telegram()).toMatchObject({
      state: 'degraded',
      detail: expect.stringContaining('no chat is allowed yet'),
    });

    await chats().allow('1234');
    expect(telegram()).toMatchObject({
      state: 'ok',
      detail: 'Connected as @pero_test_bot',
    });

    await chats().deny('1234');
    expect(telegram()).toMatchObject({
      state: 'degraded',
      detail: expect.stringContaining('no chat is allowed yet'),
    });
  });

  it('flags an allowed group where the bot is not an administrator', async () => {
    api.memberStatus.set(String(FORUM.id), 'member');
    await start();

    const { chat } = await chats().allow('-1001234567890');

    expect(chat).toMatchObject({
      bot: 'member',
      problem: expect.stringContaining("the bot isn't an administrator"),
    });
    expect(telegram()?.state).toBe('degraded');
  });

  it('refuses to deny a chat that is not allowed', async () => {
    await start();

    await expect(chats().deny('1234')).rejects.toThrow(NotFoundError);
    await expect(chats().deny('1234')).rejects.toThrow(
      'Telegram chat 1234 is not allowed',
    );
  });

  it('turns a denied chat away, and resumes its Channel and Session once allowed again', async () => {
    await start();
    await chats().allow('1234');
    api.push(message(DIRECT, 'One'));
    // The onboarding welcome, then the answer.
    await sentCount(2);
    const [session] = await db().getRepository(Session).find();

    const { chat } = await chats().deny('1234');
    expect(chat).toMatchObject({ chatId: '1234', kind: 'private' });
    api.push(message(DIRECT, 'Two'));
    const [, , hint] = await sentCount(3);

    expect(hint).toMatchObject({
      chat_id: '1234',
      text: expect.stringContaining('pero telegram allow 1234'),
    });
    expect(runtime.requests).toHaveLength(1);
    expect(await db().getRepository(Channel).count()).toBe(1);
    expect(agentNotes()).toEqual(['Main.md']);

    await chats().allow('1234');
    api.push(message(DIRECT, 'Three'));
    const sent = await sentCount(4);

    expect(sent[3]).toMatchObject({ chat_id: '1234', text: 'echo: Three' });
    expect(runtime.requests.at(-1)).toMatchObject({
      providerSessionId: session!.providerSessionId,
    });
    expect(await db().getRepository(Session).find()).toEqual([
      expect.objectContaining({ id: session!.id, status: 'active' }),
    ]);
    expect(await db().getRepository(Channel).count()).toBe(1);
    expect(agentNotes()).toEqual(['Main.md']);
  });
});
