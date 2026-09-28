import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { AgentsService } from '../agents/agents.service.js';
import { AllowedChat } from '../persistence/entities/allowed-chat.entity.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { InboundUpdate } from '../persistence/entities/inbound-update.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { AllowedChatsService } from './allowed-chats.service.js';
import type { InboundChat } from './channel-adapter.js';
import { ChannelRouter, pairingHint } from './channel-router.js';
import { ChannelOnboarding, ChannelTurns } from './channel-stages.js';
import { ChannelsModule } from './channels.module.js';
import { PAIRING_HINT_INTERVAL_MS } from './pairing-requests.js';
import {
  FakeChannelAdapter,
  groupChat,
  inboundMessage,
  membershipChanged,
  privateChat,
  topicCreated,
} from './testing/fake-channel-adapter.js';

// Beyond Number.MAX_SAFE_INTEGER, like real supergroup IDs can be.
const GROUP = groupChat('-1009007199254740993', 'Household');
const STRANGER = groupChat('-100555', 'Somewhere else');
const OWNER = privateChat('1234');

describe('ChannelRouter', () => {
  let tmp: string;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let router: ChannelRouter;
  let agents: AgentsService;
  let allowedChats: AllowedChatsService;
  let adapter: FakeChannelAdapter;
  const turns = { handle: vi.fn(() => Promise.resolve()) };
  const onboarding = {
    onUnknownChannel: vi.fn(() => Promise.resolve()),
    onEvent: vi.fn(() => Promise.resolve()),
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-channels-'));
    const vault = join(tmp, 'vault');
    mkdirSync(vault);
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: join(tmp, 'pero.sqlite') }),
        SettingsModule,
        AgentsModule,
        ChannelsModule,
      ],
    })
      .overrideProvider(ChannelTurns)
      .useValue(turns)
      .overrideProvider(ChannelOnboarding)
      .useValue(onboarding)
      .compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    router = moduleRef.get(ChannelRouter);
    agents = moduleRef.get(AgentsService);
    allowedChats = moduleRef.get(AllowedChatsService);
    await moduleRef
      .get(SettingsService)
      .update({ defaultWorkingDirectory: vault });
    adapter = new FakeChannelAdapter();
    await router.connect(adapter);
  });

  afterEach(async () => {
    await moduleRef.close();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  function allow(chat: InboundChat, title: string | null = chat.title) {
    return allowedChats.allow({
      integrationKind: 'telegram',
      chatKey: chat.key,
      kind: chat.kind,
      title,
    });
  }

  async function channel(key: string, agentName: string) {
    const agent = await agents.create({ name: agentName });
    return ds.getRepository(Channel).save({
      integrationKind: 'telegram',
      externalKey: key,
      address: {},
      title: null,
      agentId: agent.id,
    });
  }

  function reachedNextStage(): boolean {
    return (
      turns.handle.mock.calls.length +
        onboarding.onUnknownChannel.mock.calls.length +
        onboarding.onEvent.mock.calls.length >
      0
    );
  }

  describe('a chat that is not allowed', () => {
    it('never reaches the next stage and gets the pairing hint where it wrote', async () => {
      const message = inboundMessage(STRANGER, { topic: '7' });

      await adapter.deliver(message);

      expect(reachedNextStage()).toBe(false);
      expect(await ds.getRepository(InboundUpdate).count()).toBe(0);
      expect(adapter.sent).toEqual([
        {
          address: message.channel.address,
          message: { text: pairingHint('telegram', STRANGER.key) },
        },
      ]);
      expect(adapter.sent[0]!.message.text).toContain(
        `pero telegram allow ${STRANGER.key}`,
      );
    });

    it('gets the hint at most once an hour, counted per chat', async () => {
      vi.useFakeTimers({
        now: new Date('2026-09-28T10:00:00Z'),
        toFake: ['Date'],
      });

      await adapter.deliver(inboundMessage(STRANGER));
      await adapter.deliver(inboundMessage(STRANGER));
      await adapter.deliver(inboundMessage(OWNER));
      expect(adapter.sent.map((s) => s.address)).toEqual([
        STRANGER.address,
        OWNER.address,
      ]);

      vi.setSystemTime(Date.now() + PAIRING_HINT_INTERVAL_MS - 1000);
      await adapter.deliver(inboundMessage(STRANGER));
      expect(adapter.sent).toHaveLength(2);

      vi.setSystemTime(Date.now() + 1000);
      await adapter.deliver(inboundMessage(STRANGER));
      expect(adapter.sent).toHaveLength(3);
      expect(reachedNextStage()).toBe(false);
    });

    it('gets the hint in the chat itself when the bot is added', async () => {
      await adapter.emit(membershipChanged(STRANGER, 'member'));
      await adapter.emit(membershipChanged(OWNER, 'left'));
      await adapter.emit(topicCreated(STRANGER, '9'));

      expect(adapter.sent).toEqual([
        {
          address: STRANGER.address,
          message: { text: pairingHint('telegram', STRANGER.key) },
        },
      ]);
      expect(reachedNextStage()).toBe(false);
    });

    it('survives a hint that cannot be sent', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      adapter.failSends = true;

      await expect(
        adapter.deliver(inboundMessage(STRANGER)),
      ).resolves.toBeUndefined();
      expect(reachedNextStage()).toBe(false);
    });
  });

  describe('an allowed chat', () => {
    beforeEach(async () => {
      await allow(GROUP);
      await allow(OWNER);
    });

    it('resolves a known key to its Channel and assigned Agent', async () => {
      const topic = await channel(`${GROUP.key}:7`, 'groceries');
      const primary = await channel(GROUP.key, 'main');
      const message = inboundMessage(GROUP, { topic: '7' });

      await adapter.deliver(message);
      await adapter.deliver(inboundMessage(GROUP));

      expect(turns.handle).toHaveBeenCalledTimes(2);
      expect(turns.handle).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          id: topic.id,
          agent: expect.objectContaining({ name: 'groceries' }),
        }),
        message,
      );
      expect(turns.handle).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          id: primary.id,
          agent: expect.objectContaining({ name: 'main' }),
        }),
        expect.anything(),
      );
      expect(onboarding.onUnknownChannel).not.toHaveBeenCalled();
      expect(adapter.sent).toEqual([]);
    });

    it('hands an unknown key to onboarding', async () => {
      await channel(GROUP.key, 'main');
      const message = inboundMessage(GROUP, { topic: '8' });

      await adapter.deliver(message);

      expect(onboarding.onUnknownChannel).toHaveBeenCalledExactlyOnceWith(
        message,
      );
      expect(turns.handle).not.toHaveBeenCalled();
    });

    it('passes a duplicate update on only once', async () => {
      await channel(OWNER.key, 'main');
      const message = inboundMessage(OWNER, { updateId: '100' });

      await adapter.deliver(message);
      await adapter.deliver({ ...message });
      await adapter.deliver(inboundMessage(GROUP, { updateId: '100' }));

      // The third shares the update ID, so it is a redelivery too.
      expect(turns.handle).toHaveBeenCalledOnce();
      expect(onboarding.onUnknownChannel).not.toHaveBeenCalled();
      expect(await ds.getRepository(InboundUpdate).find()).toEqual([
        expect.objectContaining({
          externalUpdateId: '100',
          status: 'processed',
        }),
      ]);
    });

    it('drops messages for a disabled Channel or Agent', async () => {
      const topic = await channel(`${GROUP.key}:7`, 'groceries');
      await channel(GROUP.key, 'main');
      await ds.getRepository(Channel).update(topic.id, { enabled: false });
      await agents.edit('main', { enabled: false });

      await adapter.deliver(inboundMessage(GROUP, { topic: '7' }));
      await adapter.deliver(inboundMessage(GROUP));

      expect(reachedNextStage()).toBe(false);
    });

    it('forwards its events to onboarding, each once', async () => {
      const event = topicCreated(GROUP, '9', '200');

      await adapter.emit(event);
      await adapter.emit(event);
      await adapter.emit(membershipChanged(GROUP, 'administrator'));

      expect(onboarding.onEvent).toHaveBeenCalledTimes(2);
      expect(onboarding.onEvent).toHaveBeenNthCalledWith(1, event);
      expect(adapter.sent).toEqual([]);
    });

    it('records a new chat title', async () => {
      await allow(OWNER, null);
      await adapter.deliver(inboundMessage(groupChat(GROUP.key, 'Home')));
      await adapter.deliver(inboundMessage(OWNER));

      const titles = await ds
        .getRepository(AllowedChat)
        .find({ order: { chatKey: 'ASC' } });
      expect(titles.map((chat) => [chat.chatKey, chat.title])).toEqual([
        [GROUP.key, 'Home'],
        [OWNER.key, null],
      ]);
    });

    it('logs a failing stage and keeps routing', async () => {
      const error = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      await channel(OWNER.key, 'main');
      turns.handle.mockRejectedValueOnce(new Error('Runtime exploded'));

      await expect(
        adapter.deliver(inboundMessage(OWNER, { text: 'secret plans' })),
      ).resolves.toBeUndefined();
      await adapter.deliver(inboundMessage(OWNER));

      expect(turns.handle).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledOnce();
      expect(String(error.mock.calls[0]![0])).toContain('Runtime exploded');
      expect(String(error.mock.calls[0]![0])).not.toContain('secret plans');
    });
  });

  it('stops intake on shutdown', async () => {
    expect(adapter.running).toBe(true);

    await moduleRef.close();

    expect(adapter.running).toBe(false);
    // afterEach closes it again; a closed module ignores that.
  });

  it('refuses a second adapter of the same kind', async () => {
    await expect(router.connect(new FakeChannelAdapter())).rejects.toThrow(
      /already connected/,
    );
  });
});
