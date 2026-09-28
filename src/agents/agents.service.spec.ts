import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from '../common/errors.js';
import type { AgentCreate } from '../config/agent-input.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { AgentsModule } from './agents.module.js';
import { AgentsService } from './agents.service.js';

describe('AgentsService', () => {
  let tmp: string;
  let vault: string;
  let own: string;
  let moduleRef: TestingModule;
  let settings: SettingsService;
  let agents: AgentsService;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-agents-'));
    vault = join(tmp, 'vault');
    own = join(tmp, 'own');
    mkdirSync(vault);
    mkdirSync(own);
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
    chmodSync(tmp, 0o700);
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('without a default working directory', () => {
    it('refuses an Agent that would follow it', async () => {
      const result = agents.create({ name: 'assistant' });
      await expect(result).rejects.toThrow(InvalidInputError);
      await expect(result).rejects.toThrow(/No default working directory/);
      expect(await agents.list()).toEqual([]);
    });

    it('accepts an Agent with its own folder, which cannot then follow', async () => {
      await agents.create({ name: 'coder', workingDirectory: own });

      await expect(
        agents.edit('coder', { workingDirectory: null }),
      ).rejects.toThrow(/No default working directory/);
      expect((await agents.get('coder')).workingDirectory).toBe(own);
    });
  });

  describe('with defaults set', () => {
    beforeEach(async () => {
      await settings.update({
        defaultProvider: 'codex',
        providerDefaults: {
          claude: { model: 'claude-opus-5-5', effort: 'high' },
          codex: { model: 'gpt-5.5-codex', effort: 'minimal' },
        },
        defaultWorkingDirectory: vault,
        sharedInstructions: 'Answer in English.',
      });
    });

    describe('create', () => {
      it('copies the default provider and its options', async () => {
        const agent = await agents.create({
          name: 'Assistant',
          title: 'Personal assistant',
          instructions: 'Be brief.',
        });

        expect(agent).toMatchObject({
          id: expect.any(Number),
          name: 'assistant',
          title: 'Personal assistant',
          provider: 'codex',
          providerOptions: { model: 'gpt-5.5-codex', effort: 'minimal' },
          instructions: 'Be brief.',
          workingDirectory: null,
          useSharedInstructions: true,
          codexSkipGitRepoCheck: false,
          toolPolicy: {},
          enabled: true,
        });
        expect(await agents.get('assistant')).toEqual(agent);
      });

      it("uses the chosen provider's defaults, overridden option by option", async () => {
        const agent = await agents.create({
          name: 'health',
          provider: 'claude',
          providerOptions: { effort: 'max' },
        });

        expect(agent.providerOptions).toEqual({
          model: 'claude-opus-5-5',
          effort: 'max',
        });
      });

      it("rejects options the Agent's provider does not accept", async () => {
        const result = agents.create({
          name: 'health',
          provider: 'claude',
          providerOptions: { effort: 'minimal' },
        });
        await expect(result).rejects.toThrow(InvalidInputError);
        await expect(result).rejects.toThrow(
          /Invalid claude options: providerOptions\.effort/,
        );
      });

      it('resolves several Agents to the same default folder', async () => {
        await agents.create({ name: 'assistant' });
        await agents.create({ name: 'health', provider: 'claude' });

        expect((await agents.resolve('assistant')).workingDirectory).toBe(
          vault,
        );
        expect((await agents.resolve('health')).workingDirectory).toBe(vault);
      });

      it('keeps a folder of its own, normalized', async () => {
        const agent = await agents.create({
          name: 'coder',
          workingDirectory: `${own}/`,
        });

        expect(agent.workingDirectory).toBe(own);
        expect((await agents.resolve('coder')).workingDirectory).toBe(own);
      });

      it.each<[string, string, RegExp]>([
        ['a relative folder', 'own', /absolute path/],
        ['a home-relative folder', '~/own', /absolute path/],
        ['a missing folder', '/nonexistent/pero-own', /does not exist/],
      ])('rejects %s', async (_, workingDirectory, message) => {
        await expect(
          agents.create({ name: 'coder', workingDirectory }),
        ).rejects.toThrow(message);
        expect(await agents.list()).toEqual([]);
      });

      it.skipIf(process.getuid?.() === 0)(
        'rejects a folder it cannot write, own or default',
        async () => {
          chmodSync(own, 0o500);
          await expect(
            agents.create({ name: 'coder', workingDirectory: own }),
          ).rejects.toThrow(/must be readable and writable/);

          chmodSync(vault, 0o500);
          await expect(agents.create({ name: 'assistant' })).rejects.toThrow(
            /must be readable and writable/,
          );
          chmodSync(own, 0o700);
          chmodSync(vault, 0o700);
        },
      );

      it('rejects a default folder that has since disappeared', async () => {
        rmSync(vault, { recursive: true });

        await expect(agents.create({ name: 'assistant' })).rejects.toThrow(
          /does not exist/,
        );
      });

      it.each<[string, AgentCreate, RegExp]>([
        ['a non-slug name', { name: 'daily brief' }, /name/],
        ['an unknown field', { name: 'x', model: 'y' } as AgentCreate, /model/],
        [
          'an unknown option',
          { name: 'x', providerOptions: { temperature: 1 } as object },
          /temperature/,
        ],
      ])('rejects %s', async (_, input, message) => {
        const result = agents.create(input);
        await expect(result).rejects.toThrow(InvalidInputError);
        await expect(result).rejects.toThrow(message);
      });

      it('rejects a duplicate name, whatever its case', async () => {
        await agents.create({ name: 'assistant' });

        await expect(agents.create({ name: 'ASSISTANT' })).rejects.toThrow(
          ConflictError,
        );
        expect(await agents.list()).toHaveLength(1);
      });
    });

    it('leaves existing Agents alone when the provider defaults change', async () => {
      const before = await agents.create({ name: 'assistant' });

      await settings.update({
        defaultProvider: 'claude',
        providerDefaults: { codex: { model: 'gpt-6', effort: 'high' } },
      });

      expect(await agents.get('assistant')).toEqual(before);
      expect((await agents.create({ name: 'health' })).providerOptions).toEqual(
        { model: 'claude-opus-5-5', effort: 'high' },
      );
    });

    describe('edit', () => {
      beforeEach(async () => {
        await agents.create({ name: 'assistant', instructions: 'Be brief.' });
      });

      it('changes descriptive fields', async () => {
        const agent = await agents.edit('Assistant', {
          title: 'Assistant',
          instructions: 'Be thorough.',
          useSharedInstructions: false,
          codexSkipGitRepoCheck: true,
        });

        expect(agent).toMatchObject({
          title: 'Assistant',
          instructions: 'Be thorough.',
          useSharedInstructions: false,
          codexSkipGitRepoCheck: true,
        });
      });

      it('changes options one at a time, keeping the others', async () => {
        const agent = await agents.edit('assistant', {
          providerOptions: { effort: 'high' },
        });
        expect(agent.providerOptions).toEqual({
          model: 'gpt-5.5-codex',
          effort: 'high',
        });
      });

      it("switches provider with that provider's defaults unless options are given", async () => {
        let agent = await agents.edit('assistant', { provider: 'claude' });
        expect(agent).toMatchObject({
          provider: 'claude',
          providerOptions: { model: 'claude-opus-5-5', effort: 'high' },
        });

        agent = await agents.edit('assistant', {
          provider: 'codex',
          providerOptions: { effort: 'xhigh' },
        });
        expect(agent).toMatchObject({
          provider: 'codex',
          providerOptions: { model: 'gpt-5.5-codex', effort: 'xhigh' },
        });
      });

      it("rejects options the Agent's provider does not accept", async () => {
        await agents.edit('assistant', { provider: 'claude' });

        await expect(
          agents.edit('assistant', { providerOptions: { effort: 'minimal' } }),
        ).rejects.toThrow(/Invalid claude options/);
        await expect(
          agents.edit('assistant', {
            provider: 'claude',
            providerOptions: { effort: 'persistent' },
          }),
        ).rejects.toThrow(/Invalid claude options/);
        expect(await agents.get('assistant')).toMatchObject({
          provider: 'claude',
          providerOptions: { model: 'claude-opus-5-5', effort: 'high' },
        });
      });

      it('moves to its own folder and back to the default', async () => {
        await agents.edit('assistant', { workingDirectory: `${own}/` });
        expect((await agents.get('assistant')).workingDirectory).toBe(own);
        expect((await agents.resolve('assistant')).workingDirectory).toBe(own);

        const agent = await agents.edit('assistant', {
          workingDirectory: null,
        });
        expect(agent.workingDirectory).toBeNull();
        expect((await agents.resolve('assistant')).workingDirectory).toBe(
          vault,
        );
      });

      it('rejects an invalid folder and changes nothing', async () => {
        const before = await agents.get('assistant');

        await expect(
          agents.edit('assistant', {
            title: 'Renamed',
            workingDirectory: join(tmp, 'missing'),
          }),
        ).rejects.toThrow(/does not exist/);
        expect(await agents.get('assistant')).toEqual(before);
      });

      it('checks the folder again before enabling', async () => {
        await agents.edit('assistant', { enabled: false });
        rmSync(vault, { recursive: true });

        await expect(
          agents.edit('assistant', { enabled: true }),
        ).rejects.toThrow(/does not exist/);
        expect((await agents.get('assistant')).enabled).toBe(false);

        const agent = await agents.edit('assistant', {
          enabled: true,
          workingDirectory: own,
        });
        expect(agent.enabled).toBe(true);
      });

      it('reports an unknown Agent', async () => {
        await expect(agents.edit('nobody', { title: 'x' })).rejects.toThrow(
          NotFoundError,
        );
        await expect(agents.get('nobody')).rejects.toThrow(NotFoundError);
        await expect(agents.resolve('nobody')).rejects.toThrow(NotFoundError);
      });

      it('serializes concurrent edits', async () => {
        await Promise.all([
          agents.edit('assistant', { providerOptions: { effort: 'low' } }),
          agents.edit('assistant', { workingDirectory: own }),
          agents.edit('assistant', { provider: 'claude' }),
        ]);

        expect(await agents.get('assistant')).toMatchObject({
          provider: 'claude',
          providerOptions: { model: 'claude-opus-5-5', effort: 'high' },
          workingDirectory: own,
        });
      });
    });

    describe('resolve', () => {
      it('composes shared instructions unless the Agent opts out', async () => {
        await agents.create({ name: 'assistant', instructions: 'Be brief.' });
        await agents.create({
          name: 'coder',
          instructions: 'Write tests.',
          useSharedInstructions: false,
          workingDirectory: own,
        });

        expect(await agents.resolve('assistant')).toEqual({
          id: expect.any(Number),
          name: 'assistant',
          provider: 'codex',
          providerOptions: { model: 'gpt-5.5-codex', effort: 'minimal' },
          workingDirectory: vault,
          instructions: 'Answer in English.\n\nBe brief.',
        });
        expect((await agents.resolve('coder')).instructions).toBe(
          'Write tests.',
        );
      });

      it('applies shared instruction edits at once', async () => {
        await agents.create({ name: 'assistant', instructions: 'Be brief.' });

        await settings.update({ sharedInstructions: 'Answer in German.' });

        expect(await agents.resolve('assistant')).toMatchObject({
          instructions: 'Answer in German.\n\nBe brief.',
        });
      });
    });

    it('lists Agents by name', async () => {
      await agents.create({ name: 'health' });
      await agents.create({ name: 'assistant' });

      expect((await agents.list()).map((agent) => agent.name)).toEqual([
        'assistant',
        'health',
      ]);
    });
  });
});
