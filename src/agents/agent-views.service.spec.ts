import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '../common/errors.js';
import { MessageHistory } from '../history/message-history.service.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Session } from '../persistence/entities/session.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { inTransaction } from '../persistence/transaction.js';
import { SessionService } from '../sessions/session.service.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { AgentViews } from './agent-views.service.js';
import { AgentsModule } from './agents.module.js';
import { AgentsService } from './agents.service.js';

describe('AgentViews', () => {
  let tmp: string;
  let vault: string;
  let own: string;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let settings: SettingsService;
  let agents: AgentsService;
  let views: AgentViews;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-agent-views-'));
    vault = join(tmp, 'vault');
    own = join(tmp, 'own');
    mkdirSync(vault);
    mkdirSync(own);
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: join(tmp, 'pero.sqlite') }),
        SettingsModule,
        AgentsModule,
        SessionsModule,
      ],
    }).compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    settings = moduleRef.get(SettingsService);
    agents = moduleRef.get(AgentsService);
    views = moduleRef.get(AgentViews);
    await settings.update({ defaultWorkingDirectory: vault });
  });

  afterEach(async () => {
    await moduleRef.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function channel(agentId: number, key: string): Promise<number> {
    const channels = ds.getRepository(Channel);
    const saved = await channels.save(
      channels.create({
        integrationKind: 'telegram',
        externalKey: key,
        address: { chatId: key },
        title: `Topic ${key}`,
        agentId,
      }),
    );
    return saved.id;
  }

  /** A turn of `name` in `channelId` that reached its provider. */
  async function turn(name: string, channelId: number): Promise<Session> {
    const agent = await agents.resolve(name);
    const session = await inTransaction(ds, (manager) =>
      moduleRef.get(SessionService).beginWithin(manager, channelId, agent),
    );
    await moduleRef
      .get(SessionService)
      .recordProviderSessionId(session, `provider-${session.id}`);
    await inTransaction(ds, (manager) =>
      moduleRef.get(MessageHistory).recordInboundWithin(manager, {
        channelId,
        agentId: agent.id,
        externalMessageId: `m-${session.id}`,
        senderId: '1',
        text: 'Hello',
      }),
    );
    return session;
  }

  it('lists Agents by name with defaults resolved and the main one marked', async () => {
    await agents.create({ name: 'notes', providerOptions: { model: 'm1' } });
    await agents.create({
      name: 'coder',
      provider: 'codex',
      workingDirectory: own,
    });
    await settings.update({ mainAgent: 'coder' });

    expect(await views.list()).toEqual([
      expect.objectContaining({
        name: 'coder',
        provider: 'codex',
        model: null,
        workingDirectory: own,
        effectiveWorkingDirectory: own,
        main: true,
        enabled: true,
      }),
      expect.objectContaining({
        name: 'notes',
        model: 'm1',
        workingDirectory: null,
        effectiveWorkingDirectory: vault,
        main: false,
        permissions: 'ask',
      }),
    ]);
  });

  it("predicts each Channel's next turn from its active Session", async () => {
    const notes = await agents.create({ name: 'notes' });
    const first = await channel(notes.id, '-100:1');
    const second = await channel(notes.id, '-100:2');
    await channel(notes.id, '-100:3');
    const session = await turn('notes', first);
    await turn('notes', second);

    await agents.edit('notes', {
      providerOptions: { model: 'm2', effort: 'high' },
    });
    const edited = await views.details('NOTES');
    expect(edited.channels.map((c) => [c.key, c.nextTurn])).toEqual([
      [
        '-100:1',
        {
          kind: 'resume',
          reason: null,
          from: null,
          sessionId: session.id,
          carriesOver: false,
        },
      ],
      ['-100:2', expect.objectContaining({ kind: 'resume' })],
      [
        '-100:3',
        {
          kind: 'new',
          reason: null,
          from: null,
          sessionId: null,
          carriesOver: false,
        },
      ],
    ]);

    await agents.edit('notes', { provider: 'codex' });
    expect((await views.details('notes')).channels[0]!.nextTurn).toEqual({
      kind: 'fresh',
      reason: 'provider',
      from: 'claude',
      sessionId: session.id,
      carriesOver: true,
    });
  });

  it('sees a new default folder as a folder change for Agents that follow it', async () => {
    const notes = await agents.create({ name: 'notes' });
    const topic = await channel(notes.id, '-100:1');
    await turn('notes', topic);

    await settings.update({ defaultWorkingDirectory: own });

    expect((await views.details('notes')).channels[0]!.nextTurn).toMatchObject({
      kind: 'fresh',
      reason: 'folder',
      from: vault,
      carriesOver: true,
    });
  });

  it('warns about a folder that went missing', async () => {
    await agents.create({ name: 'coder', workingDirectory: own });
    expect((await views.details('coder')).folderProblem).toBeNull();

    rmSync(own, { recursive: true });

    expect((await views.details('coder')).folderProblem).toBe(
      `Working directory ${own} does not exist`,
    );
  });

  it('reports an unknown Agent', async () => {
    await expect(views.details('nobody')).rejects.toThrow(
      new NotFoundError('No Agent named nobody'),
    );
  });
});
