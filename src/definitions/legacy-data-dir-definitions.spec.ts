import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '../common/errors.js';
import { hostConfigIn } from '../host-config/testing/host-config-in.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { Definitions, requireAgent, requireWorkflow } from './definitions.js';
import { DefinitionsModule } from './definitions.module.js';
import { LegacyDataDirDefinitions } from './legacy-data-dir-definitions.js';

describe('LegacyDataDirDefinitions', () => {
  describe('in a legacy data directory', () => {
    let tmp: string;
    let moduleRef: TestingModule;
    let definitions: Definitions;

    async function boot(config?: string) {
      if (config !== undefined) {
        writeFileSync(join(tmp, 'config.yaml'), config);
      }
      moduleRef = await Test.createTestingModule({
        imports: [
          PersistenceModule.forRoot({ database: join(tmp, 'pero.sqlite') }),
          hostConfigIn(tmp),
          DefinitionsModule,
        ],
      }).compile();
      await moduleRef.init();
      definitions = moduleRef.get(Definitions);
    }

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'pero-definitions-'));
    });

    afterEach(async () => {
      await moduleRef.close();
      rmSync(tmp, { recursive: true, force: true });
    });

    it('serves it', async () => {
      await boot();
      expect(definitions).toBe(moduleRef.get(LegacyDataDirDefinitions));
    });

    it('keeps the defaults it had, with the data folder config.yaml names', async () => {
      await boot(`data: ${tmp}\n`);
      await moduleRef
        .get<DataSource>(getDataSourceToken())
        .query(
          `UPDATE "legacy_settings" SET "default_provider" = 'codex', ` +
            `"provider_defaults" = '{"codex":{"model":"gpt-5","effort":"high"}}', ` +
            `"default_working_directory" = '/old/vault', ` +
            `"shared_instructions" = 'Answer in English.', ` +
            `"default_permissions" = 'bypass', "timezone" = 'Europe/Berlin', ` +
            `"history_carryover" = 7, "history_retention_days" = 30, ` +
            `"max_concurrent_runs" = 3`,
        );

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
        dataFolder: tmp,
        sharedInstructions: 'Answer in English.',
      });
    });

    it('has no data folder while config.yaml names none', async () => {
      await boot();
      expect((await definitions.defaults()).dataFolder).toBeNull();
    });

    it('has no Agents, and tells every Channel it needs a workspace', async () => {
      await boot();
      await moduleRef
        .get<DataSource>(getDataSourceToken())
        .query(
          `INSERT INTO "legacy_agents" ("name", "provider", "provider_options", "tool_policy_json") ` +
            `VALUES ('main', 'claude', '{}', '{}')`,
        );

      expect(await definitions.agents()).toEqual([]);
      expect(await definitions.agent('main')).toBeNull();
      expect(await definitions.mainAgent()).toBeNull();
      expect(await definitions.mainAgentName()).toBeNull();
      await expect(requireAgent(definitions, 'main')).rejects.toThrow(
        new NotFoundError('No Agent named main'),
      );
      expect(
        await definitions.route({ id: 1, primary: true, title: null }),
      ).toEqual({ kind: 'unanswered', reason: { kind: 'legacy' } });
    });

    it('has no Workflows, whatever the legacy tables hold', async () => {
      await boot();
      const ds = moduleRef.get<DataSource>(getDataSourceToken());
      await ds.query(
        `INSERT INTO "legacy_workflows" ("name", "agent_name", "input_template") ` +
          `VALUES ('brief', 'main', 'Brief me.')`,
      );

      expect(await definitions.workflows()).toEqual([]);
      expect(await definitions.workflow('brief')).toBeNull();
      await expect(requireWorkflow(definitions, 'brief')).rejects.toThrow(
        new NotFoundError('No Workflow named brief'),
      );
    });
  });
});
