import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { AgentsService } from '../agents/agents.service.js';
import { NotFoundError } from '../common/errors.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { DefinitionIds } from './definition-ids.js';
import { Definitions, requireAgent } from './definitions.js';
import { DefinitionsModule } from './definitions.module.js';

describe('SqliteDefinitions', () => {
  let tmp: string;
  let vault: string;
  let own: string;
  let moduleRef: TestingModule;
  let definitions: Definitions;
  let ids: DefinitionIds;
  let settings: SettingsService;
  let agents: AgentsService;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-definitions-'));
    vault = join(tmp, 'vault');
    own = join(tmp, 'own');
    mkdirSync(vault);
    mkdirSync(own);
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: join(tmp, 'pero.sqlite') }),
        DefinitionsModule,
        SettingsModule,
        AgentsModule,
      ],
    }).compile();
    await moduleRef.init();
    definitions = moduleRef.get(Definitions);
    ids = moduleRef.get(DefinitionIds);
    settings = moduleRef.get(SettingsService);
    agents = moduleRef.get(AgentsService);
  });

  afterEach(async () => {
    await moduleRef.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reads the defaults from the settings', async () => {
    await settings.update({
      defaultProvider: 'codex',
      providerDefaults: { codex: { model: 'gpt-5', effort: 'high' } },
      defaultWorkingDirectory: vault,
      sharedInstructions: 'Answer in English.',
      defaultPermissions: 'bypass',
      timezone: 'Europe/Berlin',
      historyCarryover: 7,
      historyRetentionDays: 30,
      maxConcurrentRuns: 3,
    });

    expect(await definitions.defaults()).toEqual({
      provider: 'codex',
      providerDefaults: {
        claude: { model: null, effort: null },
        codex: { model: 'gpt-5', effort: 'high' },
      },
      permissions: 'bypass',
      timezone: 'Europe/Berlin',
      historyCarryover: 7,
      historyRetentionDays: 30,
      maxConcurrentRuns: 3,
      dataFolder: vault,
      sharedInstructions: 'Answer in English.',
    });
  });

  it('has no data folder until one is set', async () => {
    expect((await definitions.defaults()).dataFolder).toBeNull();
  });

  describe('with Agents', () => {
    beforeEach(async () => {
      await settings.update({ defaultWorkingDirectory: vault });
      await agents.create({ name: 'notes' });
      await agents.create({
        name: 'coder',
        title: 'Coder',
        provider: 'codex',
        providerOptions: { model: 'gpt-5', effort: 'high' },
        workingDirectory: own,
        instructions: 'Write tests first.',
        useSharedInstructions: false,
        codexSkipGitRepoCheck: true,
        permissions: 'bypass',
      });
    });

    it('reads an Agent that follows the data folder', async () => {
      expect(await definitions.agent('notes')).toEqual({
        name: 'notes',
        title: null,
        provider: 'claude',
        providerOptions: { model: null, effort: null },
        permissions: 'ask',
        workingDirectory: vault,
        ownWorkingDirectory: null,
        instructions: null,
        sharedInstructions: true,
        skipGitRepoCheck: false,
        enabled: true,
      });
    });

    it('reads an Agent with settings of its own', async () => {
      expect(await definitions.agent('coder')).toEqual({
        name: 'coder',
        title: 'Coder',
        provider: 'codex',
        providerOptions: { model: 'gpt-5', effort: 'high' },
        permissions: 'bypass',
        workingDirectory: own,
        ownWorkingDirectory: own,
        instructions: 'Write tests first.',
        sharedInstructions: false,
        skipGitRepoCheck: true,
        enabled: true,
      });
    });

    it('finds an Agent in any case, and none that does not exist', async () => {
      expect((await definitions.agent('Coder'))?.name).toBe('coder');
      expect(await definitions.agent('nobody')).toBeNull();
      await expect(requireAgent(definitions, 'nobody')).rejects.toThrow(
        new NotFoundError('No Agent named nobody'),
      );
    });

    it('lists every Agent by name', async () => {
      expect((await definitions.agents()).map((agent) => agent.name)).toEqual([
        'coder',
        'notes',
      ]);
    });

    it('follows a new data folder', async () => {
      await settings.update({ defaultWorkingDirectory: own });
      expect((await definitions.agent('notes'))?.workingDirectory).toBe(own);
    });

    it('has a main Agent once one is chosen', async () => {
      expect(await definitions.mainAgent()).toBeNull();
      await settings.update({ mainAgent: 'notes' });
      expect((await definitions.mainAgent())?.name).toBe('notes');
    });

    it('maps row IDs and names both ways', async () => {
      const id = await ids.agentId('Coder');
      expect(await ids.agentName(id)).toBe('coder');
      expect(await ids.agentNames()).toEqual(
        new Map([
          [id, 'coder'],
          [await ids.agentId('notes'), 'notes'],
        ]),
      );
      await expect(ids.agentId('nobody')).rejects.toThrow(NotFoundError);
      await expect(ids.agentName(999)).rejects.toThrow(NotFoundError);
    });
  });

  it('tells listeners when the edit services change definitions', async () => {
    const listener = vi.fn();
    const stop = definitions.onChange(listener);
    await settings.update({ defaultWorkingDirectory: vault });
    await agents.create({ name: 'notes' });
    await agents.edit('notes', { enabled: false });
    expect(listener).toHaveBeenCalledTimes(3);

    stop();
    await agents.edit('notes', { enabled: true });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
