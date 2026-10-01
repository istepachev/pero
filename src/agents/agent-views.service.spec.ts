import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { Definitions, requireAgent } from '../settings/definitions.js';
import { TestWorkspace } from '../settings/testing/test-workspace.js';
import { resolveAgent } from './agent-resolution.js';
import { AgentViews } from './agent-views.service.js';
import { AgentsModule } from './agents.module.js';

describe('AgentViews', () => {
  let ws: TestWorkspace;
  let vault: string;
  let own: string;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let views: AgentViews;

  async function boot() {
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: ws.database }),
        ws.hostConfig(),
        AgentsModule,
        SessionsModule,
      ],
    }).compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    views = moduleRef.get(AgentViews);
    ws.use(moduleRef);
  }

  beforeEach(async () => {
    ws = TestWorkspace.create('pero-agent-views-');
    vault = ws.dataFolder;
    own = join(ws.root, 'own');
    mkdirSync(own);
    await boot();
  });

  afterEach(async () => {
    await moduleRef.close();
    ws.delete();
  });

  /** A topic Channel, titled `title`. */
  async function channel(title: string, key: string): Promise<number> {
    const channels = ds.getRepository(Channel);
    const saved = await channels.save(
      channels.create({
        integrationKind: 'telegram',
        externalKey: key,
        address: { chatId: key },
        title,
      }),
    );
    return saved.id;
  }

  /** A turn of `name` in `channelId` that reached its provider. */
  async function turn(name: string, channelId: number): Promise<Session> {
    const definitions = moduleRef.get(Definitions);
    const agent = resolveAgent(
      requireAgent(definitions, name),
      definitions.defaults(),
    );
    const session = await inTransaction(ds, (manager) =>
      moduleRef.get(SessionService).beginWithin(manager, channelId, agent),
    );
    await moduleRef
      .get(SessionService)
      .recordProviderSessionId(session, `provider-${session.id}`);
    await inTransaction(ds, (manager) =>
      moduleRef.get(MessageHistory).recordInboundWithin(manager, {
        channelId,
        agentName: agent.name,
        externalMessageId: `m-${session.id}`,
        senderId: '1',
        text: 'Hello',
      }),
    );
    return session;
  }

  it('lists Agents by name with defaults resolved and the main one marked', async () => {
    await ws.agent('Notes', { model: 'm1' });
    await ws.agent('Coder', { provider: 'codex', 'working-directory': own });
    await ws.pero({ 'main-agent': 'Coder' });

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
    await ws.agent('Notes', { topics: ['One', 'Two', 'Three'] });
    const first = await channel('One', '-100:1');
    const second = await channel('Two', '-100:2');
    await channel('Three', '-100:3');
    const session = await turn('notes', first);
    await turn('notes', second);

    await ws.editAgent('Notes', { model: 'm2', effort: 'high' });
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

    await ws.editAgent('Notes', { provider: 'codex' });
    expect((await views.details('notes')).channels[0]!.nextTurn).toEqual({
      kind: 'fresh',
      reason: 'provider',
      from: 'claude',
      sessionId: session.id,
      carriesOver: true,
    });
  });

  it('sees a new data folder as a folder change for Agents that follow it', async () => {
    await ws.agent('Notes', { topics: 'One' });
    const topic = await channel('One', '-100:1');
    await turn('notes', topic);

    // A new data folder applies on restart; the notes stay where they are.
    writeFileSync(
      join(ws.stateFolder, 'config.yaml'),
      'data: own\nsettings: data/Settings\n',
    );
    await moduleRef.close();
    await boot();

    expect((await views.details('notes')).channels[0]!.nextTurn).toMatchObject({
      kind: 'fresh',
      reason: 'folder',
      from: vault,
      carriesOver: true,
    });
  });

  it('warns about a folder that went missing', async () => {
    await ws.agent('Coder', { 'working-directory': own });
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
