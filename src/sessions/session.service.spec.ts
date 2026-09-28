import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { AgentsService } from '../agents/agents.service.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Session } from '../persistence/entities/session.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { inTransaction } from '../persistence/transaction.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { SessionService } from './session.service.js';
import { SessionsModule } from './sessions.module.js';

describe('SessionService', () => {
  let tmp: string;
  let vault: string;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let sessions: SessionService;
  let agentId: number;
  let channelId: number;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-sessions-'));
    vault = join(tmp, 'vault');
    mkdirSync(vault);
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
    sessions = moduleRef.get(SessionService);
    await moduleRef
      .get(SettingsService)
      .update({ defaultWorkingDirectory: vault });
    agentId = (await moduleRef.get(AgentsService).create({ name: 'main' })).id;
    const channels = ds.getRepository(Channel);
    channelId = (
      await channels.save(
        channels.create({
          integrationKind: 'telegram',
          externalKey: '1234',
          address: { chatId: '1234' },
          title: null,
          agentId,
        }),
      )
    ).id;
  });

  afterEach(async () => {
    await moduleRef.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function begin(
    provider: 'claude' | 'codex' = 'claude',
    workingDirectory = vault,
  ): Promise<Session> {
    return inTransaction(ds, (manager) =>
      sessions.beginWithin(manager, channelId, {
        id: agentId,
        provider,
        workingDirectory,
      }),
    );
  }

  function allSessions(): Promise<Session[]> {
    return ds.getRepository(Session).find({ order: { id: 'ASC' } });
  }

  it('starts a Session with the provider and folder and no provider ID', async () => {
    const session = await begin();

    expect(session).toMatchObject({
      channelId,
      agentId,
      provider: 'claude',
      workingDirectory: vault,
      providerSessionId: null,
      status: 'active',
    });
  });

  it('resumes the active Session while provider and folder match', async () => {
    const first = await begin();
    await sessions.recordProviderSessionId(first, 'claude-1');

    const again = await begin();

    expect(again.id).toBe(first.id);
    expect(again.providerSessionId).toBe('claude-1');
    expect(await allSessions()).toHaveLength(1);
  });

  it.each([
    ['provider', 'codex' as const, undefined],
    ['folder', 'claude' as const, '/elsewhere'],
  ])(
    'closes the Session and starts a fresh one when the %s differs',
    async (_, provider, folder) => {
      const first = await begin();
      await sessions.recordProviderSessionId(first, 'claude-1');

      const fresh = await begin(provider, folder ?? vault);

      expect(fresh.id).not.toBe(first.id);
      expect(fresh.providerSessionId).toBeNull();
      expect(
        (await allSessions()).map(({ id, status }) => ({ id, status })),
      ).toEqual([
        { id: first.id, status: 'closed' },
        { id: fresh.id, status: 'active' },
      ]);
    },
  );

  it('persists a changed provider ID', async () => {
    const session = await begin();
    await sessions.recordProviderSessionId(session, 'claude-1');
    await sessions.recordProviderSessionId(session, 'claude-2');

    expect(
      await ds.getRepository(Session).findOneByOrFail({ id: session.id }),
    ).toMatchObject({ providerSessionId: 'claude-2' });
  });
});
