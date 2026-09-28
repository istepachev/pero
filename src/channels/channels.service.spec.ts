import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentsService } from '../agents/agents.service.js';
import { InvalidInputError, NotFoundError } from '../common/errors.js';
import { MessageHistory } from '../history/message-history.service.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Session } from '../persistence/entities/session.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { inTransaction } from '../persistence/transaction.js';
import { SessionService } from '../sessions/session.service.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { ChannelViews } from './channel-views.service.js';
import { ChannelsModule } from './channels.module.js';
import { ChannelsService } from './channels.service.js';

describe('ChannelsService and ChannelViews', () => {
  let tmp: string;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let agents: AgentsService;
  let channels: ChannelsService;
  let views: ChannelViews;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-channels-'));
    const vault = join(tmp, 'vault');
    mkdirSync(vault);
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: join(tmp, 'pero.sqlite') }),
        SettingsModule,
        ChannelsModule,
      ],
    }).compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    agents = moduleRef.get(AgentsService);
    channels = moduleRef.get(ChannelsService);
    views = moduleRef.get(ChannelViews);
    await moduleRef
      .get(SettingsService)
      .update({ defaultWorkingDirectory: vault });
  });

  afterEach(async () => {
    await moduleRef.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function channel(agentId: number, key: string): Promise<number> {
    const repository = ds.getRepository(Channel);
    const saved = await repository.save(
      repository.create({
        integrationKind: 'telegram',
        externalKey: key,
        address: { chatId: key },
        title: `Topic ${key}`,
        agentId,
      }),
    );
    return saved.id;
  }

  /** A turn of `name` in `channelId`: its message, Session, and reply. */
  async function turn(
    name: string,
    channelId: number,
    text: string,
  ): Promise<Session> {
    const agent = await agents.resolve(name);
    const history = moduleRef.get(MessageHistory);
    const session = await inTransaction(ds, async (manager) => {
      await history.recordInboundWithin(manager, {
        channelId,
        agentId: agent.id,
        externalMessageId: `in-${text}`,
        senderId: '1',
        text,
      });
      return moduleRef
        .get(SessionService)
        .beginWithin(manager, channelId, agent);
    });
    await moduleRef
      .get(SessionService)
      .recordProviderSessionId(session, `provider-${session.id}`);
    await history.recordOutbound({
      channelId,
      externalMessageId: `out-${text}`,
      text: `echo: ${text}`,
      author: { origin: 'agent', agentId: agent.id, sessionId: session.id },
    });
    return session;
  }

  function activeSessions(): Promise<Session[]> {
    return ds
      .getRepository(Session)
      .find({ where: { status: 'active' }, order: { id: 'ASC' } });
  }

  it('lists Channels by ID with their Agents', async () => {
    const notes = await agents.create({ name: 'notes' });
    const chef = await agents.create({ name: 'chef' });
    await agents.edit('chef', { enabled: false });
    await channel(notes.id, '-100:1');
    await channel(chef.id, '-100:2');

    expect(await views.list()).toEqual([
      expect.objectContaining({
        key: '-100:1',
        title: 'Topic -100:1',
        agent: 'notes',
        agentEnabled: true,
        enabled: true,
      }),
      expect.objectContaining({
        key: '-100:2',
        agent: 'chef',
        agentEnabled: false,
      }),
    ]);
  });

  it('shows the next turn and the size of the history', async () => {
    const notes = await agents.create({ name: 'notes' });
    const id = await channel(notes.id, '-100:1');
    expect(await views.details(id)).toMatchObject({
      nextTurn: { kind: 'new', carriesOver: false },
      messages: 0,
      lastMessageAt: null,
    });

    const session = await turn('notes', id, 'Milk');
    expect(await views.details(id)).toMatchObject({
      nextTurn: { kind: 'resume', sessionId: session.id },
      messages: 2,
      lastMessageAt: expect.any(String),
    });
  });

  it('reassigns a Channel, closing its Session so the next turn carries over', async () => {
    const notes = await agents.create({ name: 'notes' });
    const chef = await agents.create({ name: 'chef' });
    const id = await channel(notes.id, '-100:1');
    const other = await channel(notes.id, '-100:2');
    await turn('notes', id, 'Milk');
    const kept = await turn('notes', other, 'Eggs');

    expect(await channels.assign(id, 'CHEF')).toEqual({
      from: 'notes',
      to: 'chef',
      alreadyAssigned: false,
    });
    expect(await views.details(id)).toMatchObject({
      agent: 'chef',
      nextTurn: { kind: 'new', carriesOver: true },
    });
    // Only this Channel's Session closed.
    expect(await activeSessions()).toEqual([
      expect.objectContaining({ id: kept.id }),
    ]);

    await turn('chef', id, 'Bread');
    expect(await activeSessions()).toEqual([
      expect.objectContaining({ id: kept.id }),
      expect.objectContaining({ channelId: id, agentId: chef.id }),
    ]);
  });

  it('leaves the Session alone when the Channel already has that Agent', async () => {
    const notes = await agents.create({ name: 'notes' });
    const id = await channel(notes.id, '-100:1');
    const session = await turn('notes', id, 'Milk');

    expect(await channels.assign(id, 'notes')).toMatchObject({
      alreadyAssigned: true,
    });
    expect(await activeSessions()).toEqual([
      expect.objectContaining({ id: session.id }),
    ]);
  });

  it('refuses a disabled Agent, and an unknown Agent or Channel', async () => {
    const notes = await agents.create({ name: 'notes' });
    await agents.create({ name: 'chef' });
    await agents.edit('chef', { enabled: false });
    const id = await channel(notes.id, '-100:1');

    await expect(channels.assign(id, 'chef')).rejects.toThrow(
      new InvalidInputError(
        'Agent chef is disabled; enable it first with pero agents enable chef',
      ),
    );
    await expect(channels.assign(id, 'nobody')).rejects.toThrow(
      new NotFoundError('No Agent named nobody'),
    );
    await expect(channels.assign(99, 'notes')).rejects.toThrow(
      new NotFoundError('No Channel with ID 99'),
    );
    await expect(channels.setEnabled(99, false)).rejects.toThrow(NotFoundError);
    await expect(views.details(99)).rejects.toThrow(NotFoundError);
    await expect(views.history(99, 10)).rejects.toThrow(NotFoundError);
    expect(await views.details(id)).toMatchObject({ agent: 'notes' });
  });

  it('disables and enables a Channel, keeping its Session', async () => {
    const notes = await agents.create({ name: 'notes' });
    const id = await channel(notes.id, '-100:1');
    const session = await turn('notes', id, 'Milk');

    await channels.setEnabled(id, false);
    expect(await views.details(id)).toMatchObject({
      enabled: false,
      nextTurn: { kind: 'resume', sessionId: session.id },
    });
    await channels.setEnabled(id, true);
    expect(await views.details(id)).toMatchObject({ enabled: true });
  });

  it('returns the latest messages oldest first, naming the Agent of each', async () => {
    const notes = await agents.create({ name: 'notes' });
    await agents.create({ name: 'chef' });
    const id = await channel(notes.id, '-100:1');
    await turn('notes', id, 'Milk');
    await channels.assign(id, 'chef');
    await turn('chef', id, 'Bread');

    const { channel: view, messages } = await views.history(id, 3);
    expect(view).toMatchObject({ id, agent: 'chef' });
    expect(
      messages.map(({ direction, origin, agent, text }) => ({
        direction,
        origin,
        agent,
        text,
      })),
    ).toEqual([
      {
        direction: 'out',
        origin: 'agent',
        agent: 'notes',
        text: 'echo: Milk',
      },
      { direction: 'in', origin: 'user', agent: 'chef', text: 'Bread' },
      {
        direction: 'out',
        origin: 'agent',
        agent: 'chef',
        text: 'echo: Bread',
      },
    ]);
    expect((await views.history(id, 10)).messages).toHaveLength(4);
  });
});
