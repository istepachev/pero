import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { AgentsService } from '../agents/agents.service.js';
import { InvalidInputError } from '../common/errors.js';
import type { SettingsUpdate } from '../config/settings-input.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { SettingsModule } from './settings.module.js';
import { SettingsService } from './settings.service.js';

describe('SettingsService', () => {
  let tmp: string;
  let vault: string;
  let moduleRef: TestingModule;
  let settings: SettingsService;
  let agents: AgentsService;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-settings-'));
    vault = join(tmp, 'vault');
    mkdirSync(vault);
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: join(tmp, 'pero.sqlite') }),
        SettingsModule,
        AgentsModule,
      ],
    }).compile();
    await moduleRef.init();
    settings = moduleRef.get(SettingsService);
    agents = moduleRef.get(AgentsService);
  });

  afterEach(async () => {
    await moduleRef.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reads the seeded defaults', async () => {
    expect(await settings.get()).toMatchObject({
      defaultProvider: 'claude',
      defaultWorkingDirectory: null,
      sharedInstructions: null,
      maxConcurrentRuns: 2,
    });
  });

  it('updates the given fields and keeps the rest', async () => {
    const updated = await settings.update({
      defaultProvider: 'codex',
      defaultWorkingDirectory: `${vault}/`,
      sharedInstructions: 'Answer in English.',
      timezone: 'europe/berlin',
      maxConcurrentRuns: 4,
    });

    expect(updated).toMatchObject({
      defaultProvider: 'codex',
      defaultWorkingDirectory: vault,
      sharedInstructions: 'Answer in English.',
      timezone: 'Europe/Berlin',
      maxConcurrentRuns: 4,
    });
    expect(await settings.get()).toEqual(updated);

    await settings.update({ sharedInstructions: null, timezone: undefined });
    expect(await settings.get()).toMatchObject({
      sharedInstructions: null,
      timezone: 'Europe/Berlin',
    });
  });

  it('merges provider defaults option by option', async () => {
    await settings.update({
      providerDefaults: {
        claude: { model: 'claude-opus-5-5', effort: 'high' },
      },
    });
    await settings.update({
      providerDefaults: {
        claude: { effort: 'max', model: undefined },
        codex: { effort: 'minimal' },
      },
    });

    expect((await settings.get()).providerDefaults).toEqual({
      claude: { model: 'claude-opus-5-5', effort: 'max' },
      codex: { model: null, effort: 'minimal' },
    });

    await settings.update({ providerDefaults: { claude: { model: null } } });
    expect((await settings.get()).providerDefaults.claude).toEqual({
      model: null,
      effort: 'max',
    });
  });

  it.each<[string, SettingsUpdate, RegExp]>([
    [
      'an unknown provider',
      { defaultProvider: 'gpt' as 'claude' },
      /defaultProvider/,
    ],
    [
      "another provider's effort",
      { providerDefaults: { claude: { effort: 'minimal' as 'low' } } },
      /providerDefaults\.claude\.effort/,
    ],
    [
      'an unknown option',
      { providerDefaults: { codex: { temperature: 1 } as object } },
      /temperature/,
    ],
    ['an unknown field', { theme: 'dark' } as SettingsUpdate, /theme/],
    [
      'an unknown time zone',
      { timezone: 'Mars/Base' },
      /timezone: must be an IANA/,
    ],
    ['a fixed offset', { timezone: '+05:00' }, /timezone: must be an IANA/],
    ['no concurrent runs', { maxConcurrentRuns: 0 }, /maxConcurrentRuns/],
    ['a fractional limit', { maxConcurrentRuns: 1.5 }, /maxConcurrentRuns/],
    [
      'a relative folder',
      { defaultWorkingDirectory: 'vault' },
      /absolute path/,
    ],
    [
      'a missing folder',
      { defaultWorkingDirectory: '/nonexistent/pero-vault' },
      /does not exist/,
    ],
  ])('rejects %s and changes nothing', async (_, patch, message) => {
    const before = await settings.get();

    const result = settings.update(patch);
    await expect(result).rejects.toThrow(InvalidInputError);
    await expect(result).rejects.toThrow(message);
    expect(await settings.get()).toEqual(before);
  });

  it('never clears the default working directory once set', async () => {
    await settings.update({ defaultWorkingDirectory: vault });

    await expect(
      settings.update({ defaultWorkingDirectory: null as unknown as string }),
    ).rejects.toThrow(/cannot be cleared/);
    expect((await settings.get()).defaultWorkingDirectory).toBe(vault);
  });

  describe('changing the default working directory', () => {
    let other: string;
    let own: string;

    beforeEach(async () => {
      other = join(tmp, 'other');
      own = join(tmp, 'own');
      mkdirSync(other);
      mkdirSync(own);
      await settings.update({ defaultWorkingDirectory: vault });
      await agents.create({ name: 'assistant' });
      await agents.create({ name: 'health' });
      await agents.create({ name: 'coder', workingDirectory: own });
      await agents.edit('health', { enabled: false });
    });

    async function versions() {
      return Object.fromEntries(
        (await agents.list()).map((agent) => [
          agent.name,
          agent.executionConfigVersion,
        ]),
      );
    }

    it('moves and bumps every Agent that follows it, and no other', async () => {
      await settings.update({ defaultWorkingDirectory: other });

      expect(await versions()).toEqual({ assistant: 2, health: 2, coder: 1 });
      expect((await agents.resolve('assistant')).workingDirectory).toBe(other);
      expect((await agents.resolve('health')).workingDirectory).toBe(other);
      expect((await agents.resolve('coder')).workingDirectory).toBe(own);
    });

    it('bumps nothing when the folder stays the same', async () => {
      await settings.update({ defaultWorkingDirectory: `${vault}/` });
      await settings.update({ sharedInstructions: 'Answer in English.' });

      expect(await versions()).toEqual({ assistant: 1, health: 1, coder: 1 });
    });
  });
});
