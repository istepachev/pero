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
import { Agent } from '../persistence/entities/agent.entity.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Message } from '../persistence/entities/message.entity.js';
import {
  SETTINGS_ID,
  Settings,
} from '../persistence/entities/settings.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { AllowedChatsService } from './allowed-chats.service.js';
import {
  MAIN_AGENT_NAME,
  setupHint,
  welcomeText,
} from './channel-onboarding.service.js';
import { ChannelRouter } from './channel-router.js';
import { ChannelTurns } from './channel-stages.js';
import { ChannelsModule } from './channels.module.js';
import {
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
  let tmp: string;
  let vault: string;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let agents: AgentsService;
  let settings: SettingsService;
  let adapter: FakeChannelAdapter;
  const turns = {
    handle: vi.fn(() => Promise.resolve()),
    drain: vi.fn(() => Promise.resolve()),
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-onboarding-'));
    vault = join(tmp, 'vault');
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
      .compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    agents = moduleRef.get(AgentsService);
    settings = moduleRef.get(SettingsService);
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
  });

  afterEach(async () => {
    await moduleRef.close();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  function allAgents(): Promise<Agent[]> {
    return ds.getRepository(Agent).find({ order: { id: 'ASC' } });
  }

  function allChannels(): Promise<Channel[]> {
    return ds.getRepository(Channel).find({ order: { id: 'ASC' } });
  }

  async function channelFor(key: string): Promise<Channel & { agent: Agent }> {
    return (await ds.getRepository(Channel).findOneOrFail({
      where: { integrationKind: 'telegram', externalKey: key },
      relations: { agent: true },
    })) as Channel & { agent: Agent };
  }

  async function mainAgentId(): Promise<number | null> {
    return (
      await ds.getRepository(Settings).findOneByOrFail({ id: SETTINGS_ID })
    ).mainAgentId;
  }

  function allMessages(): Promise<Message[]> {
    return ds.getRepository(Message).find({ order: { id: 'ASC' } });
  }

  function sentTexts(): string[] {
    return adapter.sent.map((sent) => sent.message.text);
  }

  describe('with a default working directory', () => {
    beforeEach(async () => {
      await settings.update({
        defaultProvider: 'codex',
        providerDefaults: { codex: { model: 'gpt-5.5-codex', effort: 'low' } },
        defaultWorkingDirectory: vault,
      });
    });

    it('gives a created topic a new Agent named after it and a welcome', async () => {
      await adapter.emit(
        topicCreated(GROUP, '7', { title: 'Groceries & Errands' }),
      );

      const [agent] = await allAgents();
      expect(agent).toMatchObject({
        name: 'groceries-errands',
        title: 'Groceries & Errands',
        provider: 'codex',
        providerOptions: { model: 'gpt-5.5-codex', effort: 'low' },
        workingDirectory: null,
        instructions: null,
        useSharedInstructions: true,
      });
      const topic = inboundChannel(GROUP, '7', 'Groceries & Errands');
      expect(await allChannels()).toEqual([
        expect.objectContaining({
          integrationKind: 'telegram',
          externalKey: topic.key,
          address: topic.address,
          title: 'Groceries & Errands',
          agentId: agent!.id,
          enabled: true,
        }),
      ]);
      expect(adapter.sent).toEqual([
        {
          address: topic.address,
          message: { text: welcomeText(agent!, vault, 'topic') },
        },
      ]);
      // The welcome is Pero's notice in the Channel's history.
      expect(await allMessages()).toEqual([
        expect.objectContaining({
          channelId: (await channelFor(topic.key)).id,
          agentId: null,
          sessionId: null,
          direction: 'out',
          origin: 'pero',
          externalMessageId: '1',
          senderId: null,
          text: welcomeText(agent!, vault, 'topic'),
        }),
      ]);
      expect(sentTexts()[0]).toBe(
        `This topic talks to Agent groceries-errands: codex, model ` +
          `gpt-5.5-codex, working in ${vault}. To change it, run on the ` +
          `Pero host: pero agents edit groceries-errands`,
      );
      expect(turns.handle).not.toHaveBeenCalled();
    });

    it.each([
      ['the event, then the message', 'event-first'],
      ['the message, then the event', 'message-first'],
      ['both at once', 'together'],
    ] as const)(
      'makes one Agent and one Channel for a topic when %s arrive',
      async (_, order) => {
        const error = vi.spyOn(Logger.prototype, 'error');
        const event = topicCreated(GROUP, '7', { title: 'Groceries' });
        const message = inboundMessage(GROUP, {
          topic: '7',
          title: 'Groceries',
        });

        if (order === 'event-first') {
          await adapter.emit(event);
          await adapter.deliver(message);
        } else if (order === 'message-first') {
          await adapter.deliver(message);
          await adapter.emit(event);
        } else {
          await Promise.all([adapter.emit(event), adapter.deliver(message)]);
        }

        expect((await allAgents()).map((agent) => agent.name)).toEqual([
          'groceries',
        ]);
        expect(await allChannels()).toHaveLength(1);
        expect(adapter.sent).toHaveLength(1);
        expect(error).not.toHaveBeenCalled();
        expect(turns.handle).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            externalKey: message.channel.key,
            agent: expect.objectContaining({ name: 'groceries' }),
          }),
          message,
          expect.any(Number),
        );
      },
    );

    it('welcomes a Channel before its first message goes to the Agent', async () => {
      let sentBeforeTurn = -1;
      turns.handle.mockImplementationOnce(() => {
        sentBeforeTurn = adapter.sent.length;
        return Promise.resolve();
      });

      await adapter.deliver(inboundMessage(GROUP, { topic: '7' }));

      expect(sentBeforeTurn).toBe(1);
    });

    it('makes names unique', async () => {
      await agents.create({ name: 'groceries-2' });
      const long = 'x'.repeat(80);

      await adapter.emit(topicCreated(GROUP, '1', { title: 'Groceries' }));
      await adapter.emit(topicCreated(GROUP, '2', { title: 'groceries!' }));
      await adapter.emit(topicCreated(GROUP, '3', { title: long }));
      await adapter.emit(topicCreated(GROUP, '4', { title: long }));

      const names = (await allAgents()).map((agent) => agent.name);
      expect(names).toEqual([
        'groceries-2',
        'groceries',
        'groceries-3',
        'x'.repeat(64),
        `${'x'.repeat(62)}-2`,
      ]);
      expect((await channelFor(`${GROUP.key}:2`)).agent.title).toBe(
        'groceries!',
      );
    });

    it('names an Agent after its topic ID when the title has no letters or digits', async () => {
      await adapter.emit(topicCreated(GROUP, '12', { title: '🎉 !!' }));
      // A message whose topic's creation Telegram did not attach.
      await adapter.deliver(
        inboundMessage(GROUP, { topic: '13', title: null }),
      );

      const twelve = await channelFor(`${GROUP.key}:12`);
      expect(twelve.agent).toMatchObject({ name: 'topic-12', title: '🎉 !!' });
      const thirteen = await channelFor(`${GROUP.key}:13`);
      expect(thirteen.title).toBeNull();
      expect(thirteen.agent).toMatchObject({ name: 'topic-13', title: null });
    });

    it('gives a General topic and a direct chat the main Agent through separate Channels', async () => {
      await adapter.deliver(inboundMessage(GROUP));
      await adapter.deliver(inboundMessage(OWNER));

      const [main] = await allAgents();
      expect(await allAgents()).toHaveLength(1);
      expect(main).toMatchObject({ name: MAIN_AGENT_NAME, title: null });
      expect(await mainAgentId()).toBe(main!.id);
      const channels = await allChannels();
      expect(channels.map((c) => [c.externalKey, c.agentId])).toEqual([
        [GROUP.key, main!.id],
        [OWNER.key, main!.id],
      ]);
      expect(channels[0]!.title).toBe('Household');
      expect(sentTexts()).toEqual([
        welcomeText(main!, vault, 'chat'),
        welcomeText(main!, vault, 'chat'),
      ]);
      expect(adapter.sent.map((sent) => sent.address)).toEqual([
        GROUP.address,
        OWNER.address,
      ]);
      expect(turns.handle).toHaveBeenCalledTimes(2);
    });

    it('gives primary Channels the Agent the main-agent setting names', async () => {
      const assistant = await agents.create({ name: 'assistant' });
      await ds
        .getRepository(Settings)
        .update(SETTINGS_ID, { mainAgentId: assistant.id });

      await adapter.deliver(inboundMessage(OWNER));

      expect((await channelFor(OWNER.key)).agentId).toBe(assistant.id);
      expect(await allAgents()).toHaveLength(1);
    });

    it('makes an Agent already named main the main Agent', async () => {
      const main = await agents.create({ name: 'main', title: 'Mine' });

      await adapter.deliver(inboundMessage(OWNER));

      expect((await channelFor(OWNER.key)).agentId).toBe(main.id);
      expect(await mainAgentId()).toBe(main.id);
      expect(await allAgents()).toHaveLength(1);
    });

    it("never changes an existing Channel's assignment", async () => {
      const error = vi.spyOn(Logger.prototype, 'error');
      const assistant = await agents.create({ name: 'assistant' });
      const topic = inboundChannel(GROUP, '7', 'Old');
      await ds.getRepository(Channel).save({
        integrationKind: 'telegram',
        externalKey: topic.key,
        address: topic.address,
        title: 'Old',
        agentId: assistant.id,
      });

      await adapter.emit(topicCreated(GROUP, '7', { title: 'New' }));

      expect(await channelFor(topic.key)).toMatchObject({
        agentId: assistant.id,
        title: 'Old',
      });
      expect(await allAgents()).toHaveLength(1);
      expect(adapter.sent).toEqual([]);
      expect(error).not.toHaveBeenCalled();
    });

    it('does not onboard a disabled Channel again', async () => {
      await adapter.emit(topicCreated(GROUP, '7'));
      const { id } = await channelFor(`${GROUP.key}:7`);
      await ds.getRepository(Channel).update(id, { enabled: false });

      await adapter.deliver(inboundMessage(GROUP, { topic: '7' }));

      expect(await allAgents()).toHaveLength(1);
      expect(adapter.sent).toHaveLength(1);
      expect(turns.handle).not.toHaveBeenCalled();
    });

    it('keeps a new Channel whose welcome cannot be sent', async () => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      adapter.failSends = true;

      await adapter.deliver(inboundMessage(GROUP, { topic: '7' }));

      expect(await allChannels()).toHaveLength(1);
      expect(turns.handle).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]![0])).toContain('Service unreachable');
      // Only the message that was received; the welcome never went out.
      expect((await allMessages()).map((m) => m.origin)).toEqual(['user']);
    });

    describe('a renamed topic', () => {
      beforeEach(async () => {
        await adapter.emit(topicCreated(GROUP, '7', { title: 'Groceries' }));
      });

      it('changes the Channel and Agent titles, never the name', async () => {
        await adapter.emit(topicRenamed(GROUP, '7', 'Shopping'));

        const channel = await channelFor(`${GROUP.key}:7`);
        expect(channel.title).toBe('Shopping');
        expect(channel.agent).toMatchObject({
          name: 'groceries',
          title: 'Shopping',
        });
      });

      it('keeps a title the owner gave the Agent', async () => {
        await agents.edit('groceries', { title: 'My list' });

        await adapter.emit(topicRenamed(GROUP, '7', 'Food'));

        const channel = await channelFor(`${GROUP.key}:7`);
        expect(channel.title).toBe('Food');
        expect(channel.agent.title).toBe('My list');
      });

      it('creates nothing when the topic is unknown', async () => {
        await adapter.emit(topicRenamed(GROUP, '8', 'Elsewhere'));

        expect(await allChannels()).toHaveLength(1);
        expect(await allAgents()).toHaveLength(1);
      });
    });
  });

  describe('without a default working directory', () => {
    beforeEach(() => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    it('creates nothing, hints where it was asked, and succeeds once the folder is set', async () => {
      const topicMessage = inboundMessage(GROUP, { topic: '7' });
      await adapter.deliver(topicMessage);
      await adapter.deliver(inboundMessage(OWNER));

      expect(await allAgents()).toEqual([]);
      expect(await allChannels()).toEqual([]);
      expect(await mainAgentId()).toBeNull();
      expect(turns.handle).not.toHaveBeenCalled();
      const hint = setupHint('No default working directory is set');
      expect(adapter.sent).toEqual([
        { address: topicMessage.channel.address, message: { text: hint } },
        { address: OWNER.address, message: { text: hint } },
      ]);
      expect(hint).toContain('pero settings set default-working-directory');
      expect(await allMessages()).toEqual([]);

      await settings.update({ defaultWorkingDirectory: vault });
      await adapter.deliver(inboundMessage(GROUP, { topic: '7' }));
      await adapter.deliver(inboundMessage(OWNER));

      expect((await allAgents()).map((agent) => agent.name)).toEqual([
        'topic-7',
        'main',
      ]);
      expect(await allChannels()).toHaveLength(2);
      expect(turns.handle).toHaveBeenCalledTimes(2);
    });

    it('still gives a primary Channel a main Agent that exists', async () => {
      const own = join(tmp, 'own');
      mkdirSync(own);
      const assistant = await agents.create({
        name: 'assistant',
        workingDirectory: own,
      });
      await ds
        .getRepository(Settings)
        .update(SETTINGS_ID, { mainAgentId: assistant.id });

      await adapter.deliver(inboundMessage(OWNER));

      expect((await channelFor(OWNER.key)).agentId).toBe(assistant.id);
      expect(sentTexts()).toEqual([welcomeText(assistant, own, 'chat')]);
    });

    it('hints when the default folder has gone missing', async () => {
      await settings.update({ defaultWorkingDirectory: vault });
      rmSync(vault, { recursive: true });

      await adapter.deliver(inboundMessage(GROUP, { topic: '7' }));

      expect(await allAgents()).toEqual([]);
      expect(await allChannels()).toEqual([]);
      expect(sentTexts()).toEqual([
        setupHint(`Working directory ${vault} does not exist`),
      ]);
    });
  });
});
