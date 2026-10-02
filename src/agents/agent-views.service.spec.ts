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
import { Definitions, requireAgent } from '../system/definitions.js';
import { TestWorkspace } from '../system/testing/test-workspace.js';
import { AgentViews } from './agent-views.service.js';
import { AgentsModule } from './agents.module.js';

describe('AgentViews', () => {
  let ws: TestWorkspace;
  let workspace: string;
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
    workspace = ws.root;
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
    const agent = requireAgent(definitions, name);
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
        effectiveWorkingDirectory: workspace,
        main: false,
        permissions: 'ask',
      }),
    ]);
  });

  it("predicts each Channel's next turn from its active Session", async () => {
    // The main Agent answers the General topic of each group.
    await ws.agent('Notes');
    await ws.pero({ 'main-agent': 'Notes' });
    const first = await channel('General', '-100');
    const second = await channel('General', '-200');
    await channel('General', '-300');
    const session = await turn('notes', first);
    await turn('notes', second);

    await ws.editAgent('Notes', { model: 'm2', effort: 'high' });
    const edited = await views.details('NOTES');
    expect(edited.channels.map((c) => [c.key, c.nextTurn])).toEqual([
      [
        '-100',
        {
          kind: 'resume',
          reason: null,
          from: null,
          sessionId: session.id,
          carriesOver: false,
        },
      ],
      ['-200', expect.objectContaining({ kind: 'resume' })],
      [
        '-300',
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

  it('keeps the Session when the data folder moves', async () => {
    await ws.agent('Notes', { topic: 'One' });
    const topic = await channel('One', '-100:1');
    await turn('notes', topic);

    // A new data folder applies on restart; the notes stay where they are.
    writeFileSync(
      join(ws.stateFolder, 'config.yaml'),
      'data: own\nsystem: data/System\n',
    );
    await moduleRef.close();
    await boot();

    expect((await views.details('notes')).channels[0]!.nextTurn).toMatchObject({
      kind: 'resume',
      reason: null,
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
