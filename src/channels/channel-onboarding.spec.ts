import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Message } from '../persistence/entities/message.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { TestWorkspace } from '../settings/testing/test-workspace.js';
import { AllowedChatsService } from './allowed-chats.service.js';
import { firstStepsText, welcomeText } from './channel-onboarding.service.js';
import { ChannelRouter } from './channel-router.js';
import { ChannelOnboarding, ChannelTurns } from './channel-stages.js';
import { ChannelsModule } from './channels.module.js';
import {
  chatMigrated,
  FakeChannelAdapter,
  groupChat,
  inboundChannel,
  inboundMessage,
  privateChat,
  topicCreated,
  topicRenamed,
} from './testing/fake-channel-adapter.js';

const GROUP = groupChat('-1009007199254740993', 'Household');
const OWNER = privateChat('1234');

describe('Channel onboarding', () => {
  let moduleRef: TestingModule;
  let ds: DataSource;
  let adapter: FakeChannelAdapter;
  const turns = {
    handle: vi.fn(() => Promise.resolve()),
    drain: vi.fn(() => Promise.resolve()),
  };

  /** Starts onboarding with the host config `hostConfig`, allowing both chats. */
  async function boot(
    database: string,
    hostConfig: ReturnType<TestWorkspace['hostConfig']>,
  ): Promise<void> {
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database }),
        hostConfig,
        AgentsModule,
        ChannelsModule,
      ],
    })
      .overrideProvider(ChannelTurns)
      .useValue(turns)
      .compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    const allowedChats = moduleRef.get(AllowedChatsService);
    for (const chat of [GROUP, OWNER]) {
      await allowedChats.allow({
        integrationKind: 'telegram',
        chatKey: chat.key,
        kind: chat.kind,
        title: chat.title,
      });
    }
    adapter = new FakeChannelAdapter();
    await moduleRef.get(ChannelRouter).connect(adapter);
  }

  afterEach(async () => {
    await moduleRef.close();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  function allChannels(): Promise<Channel[]> {
    return ds.getRepository(Channel).find({ order: { id: 'ASC' } });
  }

  function channelFor(key: string): Promise<Channel> {
    return ds
      .getRepository(Channel)
      .findOneByOrFail({ integrationKind: 'telegram', externalKey: key });
  }

  function allMessages(): Promise<Message[]> {
    return ds.getRepository(Message).find({ order: { id: 'ASC' } });
  }

  describe('in a workspace', () => {
    let ws: TestWorkspace;

    beforeEach(async () => {
      ws = TestWorkspace.create('pero-onboarding-');
      await ws.pero({
        provider: 'codex',
        'codex-model': 'gpt-5.5-codex',
        'codex-effort': 'low',
        timezone: 'Asia/Tokyo',
      });
      await ws.agent('Main');
      await boot(ws.database, ws.hostConfig());
    });

    afterEach(() => {
      ws.delete();
    });

    it('records a created topic and welcomes it with who answers there', async () => {
      await adapter.emit(
        topicCreated(GROUP, '7', { title: 'Groceries & Errands' }),
      );

      const topic = inboundChannel(GROUP, '7', 'Groceries & Errands');
      expect(await allChannels()).toEqual([
        expect.objectContaining({
          integrationKind: 'telegram',
          externalKey: topic.key,
          address: topic.address,
          title: 'Groceries & Errands',
        }),
      ]);
      const welcome =
        `This topic talks to Agent groceries-errands: codex, model ` +
        `gpt-5.5-codex, working in ${ws.root}. Its settings and ` +
        `instructions are in data/Settings/Agents/Groceries & Errands.md: ` +
        `edit that note, or ask here to change them.`;
      expect(
        welcomeText(
          {
            name: 'groceries-errands',
            provider: 'codex',
            model: 'gpt-5.5-codex',
          },
          ws.root,
          'data/Settings/Agents/Groceries & Errands.md',
          'topic',
        ),
      ).toBe(welcome);
      expect(adapter.sent).toEqual([
        { address: topic.address, message: { text: welcome } },
      ]);
      // The welcome is Pero's notice in the Channel's history.
      expect(await allMessages()).toEqual([
        expect.objectContaining({
          channelId: (await channelFor(topic.key)).id,
          agentName: null,
          sessionId: null,
          direction: 'out',
          origin: 'pero',
          externalMessageId: '1',
          senderId: null,
          text: welcome,
        }),
      ]);
      expect(turns.handle).not.toHaveBeenCalled();
    });

    it('welcomes a Channel before its first message goes to the Agent', async () => {
      let sentBeforeTurn = -1;
      turns.handle.mockImplementationOnce(() => {
        sentBeforeTurn = adapter.sent.length;
        return Promise.resolve();
      });

      await adapter.deliver(
        inboundMessage(GROUP, { topic: '7', title: 'Groceries' }),
      );

      expect(sentBeforeTurn).toBe(1);
    });

    it('welcomes a chat that was just allowed with the first steps, once', async () => {
      await moduleRef.get(ChannelOnboarding).onChatAllowed('telegram', GROUP);

      const steps = firstStepsText(
        { name: 'main', provider: 'codex', model: 'gpt-5.5-codex' },
        ws.root,
        {
          note: 'data/Settings/Agents/Main.md',
          pero: 'data/Settings/Pero.md',
          agents: 'data/Settings/Agents/',
          workflows: 'data/Settings/Workflows/',
          timezone: 'Asia/Tokyo',
        },
        'group',
      );
      expect(steps).toMatch(
        /^This chat talks to Agent main: codex, model gpt-5\.5-codex, working in .+\.\n\nFirst steps:\n1\. Make it yours: this Agent's personality and instructions are in data\/Settings\/Agents\/Main\.md\./,
      );
      expect(steps).toContain('2. Create a topic for each subject');
      expect(steps).toContain(
        '3. Schedules use the time zone Asia/Tokyo. Set yours, and defaults for every Agent such as the provider and model, in data/Settings/Pero.md.',
      );
      expect(steps).toContain(
        'Workflows are notes in data/Settings/Workflows/.',
      );
      expect(adapter.sent).toEqual([
        { address: GROUP.address, message: { text: steps } },
      ]);
      expect(await allChannels()).toEqual([
        expect.objectContaining({ externalKey: GROUP.key, title: 'Household' }),
      ]);

      // Its first message goes straight to the Agent, and allowing it again
      // after a restart's worth of forgetting changes nothing.
      await adapter.deliver(inboundMessage(GROUP));
      await moduleRef.get(ChannelOnboarding).onChatAllowed('telegram', GROUP);

      expect(adapter.sent).toHaveLength(1);
      expect(turns.handle).toHaveBeenCalledOnce();
    });

    it('tells a direct chat how to get an Agent per topic', async () => {
      await adapter.deliver(inboundMessage(OWNER));

      expect(adapter.sent).toHaveLength(1);
      const text = String(adapter.sent[0]!.message.text);
      expect(text).toMatch(/^This chat talks to Agent main: /);
      expect(text).toContain(
        '2. Get an Agent per subject: create a private Telegram group',
      );
      expect(text).not.toContain('Create a topic for each subject');
    });

    it('keeps a new Channel whose welcome cannot be sent', async () => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      adapter.failSends = true;

      await adapter.deliver(inboundMessage(OWNER));

      expect(await allChannels()).toHaveLength(1);
      expect(turns.handle).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]![0])).toContain('Service unreachable');
      // Only the message that was received; the welcome never went out.
      expect((await allMessages()).map((m) => m.origin)).toEqual(['user']);
    });

    it("retitles a renamed topic's Channel", async () => {
      await adapter.emit(topicCreated(GROUP, '7', { title: 'Groceries' }));

      await adapter.emit(topicRenamed(GROUP, '7', 'Shopping'));

      expect((await channelFor(`${GROUP.key}:7`)).title).toBe('Shopping');
    });

    it('creates nothing when a renamed topic is unknown', async () => {
      await adapter.emit(topicRenamed(GROUP, '8', 'Elsewhere'));

      expect(await allChannels()).toEqual([]);
    });

    describe('a migrated chat', () => {
      const BASIC = groupChat('-4567', 'Family');
      const SUPERGROUP_KEY = '-1009876543210';

      beforeEach(async () => {
        await moduleRef.get(AllowedChatsService).allow({
          integrationKind: 'telegram',
          chatKey: BASIC.key,
          kind: 'group',
          title: BASIC.title,
        });
        await adapter.deliver(inboundMessage(BASIC));
      });

      async function allowedKeys(): Promise<string[]> {
        return (await moduleRef.get(AllowedChatsService).list('telegram')).map(
          (chat) => chat.chatKey,
        );
      }

      it('moves its allowlist entry and primary Channel to the new ID', async () => {
        const before = await channelFor(BASIC.key);

        await adapter.emit(chatMigrated(BASIC, SUPERGROUP_KEY));

        expect(await allowedKeys()).toEqual([
          GROUP.key,
          OWNER.key,
          SUPERGROUP_KEY,
        ]);
        expect(await channelFor(SUPERGROUP_KEY)).toMatchObject({
          id: before.id,
          address: { chatId: SUPERGROUP_KEY },
        });
        // Messages from the new ID reach the same Channel.
        await adapter.deliver(
          inboundMessage(groupChat(SUPERGROUP_KEY, 'Family')),
        );
        expect(turns.handle).toHaveBeenLastCalledWith(
          expect.objectContaining({ id: before.id }),
          expect.anything(),
          expect.any(Number),
        );
      });

      it('does the move once when both halves of it arrive', async () => {
        await adapter.emit(chatMigrated(BASIC, SUPERGROUP_KEY));
        await adapter.emit(chatMigrated(BASIC, SUPERGROUP_KEY));

        expect(await allowedKeys()).toContain(SUPERGROUP_KEY);
        expect(await allChannels()).toHaveLength(1);
      });

      it('drops the old entry when the new ID is already allowed', async () => {
        await moduleRef.get(AllowedChatsService).allow({
          integrationKind: 'telegram',
          chatKey: SUPERGROUP_KEY,
          kind: 'group',
          title: 'Family',
        });

        await adapter.emit(chatMigrated(BASIC, SUPERGROUP_KEY));

        expect(await allowedKeys()).toEqual([
          GROUP.key,
          OWNER.key,
          SUPERGROUP_KEY,
        ]);
        expect((await channelFor(SUPERGROUP_KEY)).externalKey).toBe(
          SUPERGROUP_KEY,
        );
      });

      it('keeps a Channel whose new key is taken', async () => {
        await moduleRef.get(AllowedChatsService).allow({
          integrationKind: 'telegram',
          chatKey: SUPERGROUP_KEY,
          kind: 'group',
          title: 'Family',
        });
        await adapter.deliver(
          inboundMessage(groupChat(SUPERGROUP_KEY, 'Family')),
        );
        const warn = vi.spyOn(Logger.prototype, 'warn');

        await adapter.emit(chatMigrated(BASIC, SUPERGROUP_KEY));

        expect(
          (await allChannels()).map((channel) => channel.externalKey),
        ).toEqual([BASIC.key, SUPERGROUP_KEY]);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('already exists'),
        );
      });
    });
  });
});
