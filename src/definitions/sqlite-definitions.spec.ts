import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { NotFoundError } from '../common/errors.js';
import { hostConfigIn } from '../host-config/testing/host-config-in.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { TestWorkspace } from '../settings-notes/testing/test-workspace.js';
import { TriggersModule } from '../triggers/triggers.module.js';
import { TriggersService } from '../triggers/triggers.service.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { DefinitionIds } from './definition-ids.js';
import { Definitions, requireAgent, requireWorkflow } from './definitions.js';
import { DefinitionsModule } from './definitions.module.js';
import { SqliteDefinitions } from './sqlite-definitions.js';

describe('SqliteDefinitions', () => {
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
      expect(definitions).toBe(moduleRef.get(SqliteDefinitions));
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

    it('has no Agents, and tells every Channel to migrate', async () => {
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
  });

  describe('Workflows', () => {
    let ws: TestWorkspace;
    let moduleRef: TestingModule;
    let definitions: SqliteDefinitions;
    let ids: DefinitionIds;
    let workflows: WorkflowsService;
    let triggers: TriggersService;

    beforeEach(async () => {
      ws = TestWorkspace.create('pero-definitions-');
      await ws.agent('Coach');
      moduleRef = await Test.createTestingModule({
        imports: [
          PersistenceModule.forRoot({ database: ws.database }),
          ws.hostConfig(),
          DefinitionsModule,
          AgentsModule,
          WorkflowsModule,
          TriggersModule,
        ],
      }).compile();
      await moduleRef.init();
      definitions = moduleRef.get(SqliteDefinitions);
      ids = moduleRef.get(DefinitionIds);
      workflows = moduleRef.get(WorkflowsService);
      triggers = moduleRef.get(TriggersService);
    });

    afterEach(async () => {
      await moduleRef.close();
      ws.delete();
    });

    describe('with Workflows', () => {
      let english: number;
      let direct: number;

      beforeEach(async () => {
        const ds = moduleRef.get<DataSource>(getDataSourceToken());
        const channels = ds.getRepository(Channel);
        [direct, english] = (
          await channels.save([
            channels.create({
              integrationKind: 'telegram',
              externalKey: '1234',
              address: { chatId: '1234' },
              title: null,
            }),
            channels.create({
              integrationKind: 'telegram',
              externalKey: '-100777:7',
              address: { chatId: '-100777', topicId: '7' },
              title: 'English',
            }),
          ])
        ).map((channel) => channel.id);
        await workflows.create({
          name: 'evening-review',
          title: 'Evening review',
          agent: 'coach',
          inputTemplate: "Review today's chats.",
          history: { channels: [english], hours: 12 },
          maxAttempts: 3,
        });
        await workflows.create({
          name: 'brief',
          agent: 'coach',
          inputTemplate: 'Brief me.',
        });
      });

      it('reads a Workflow with its Agent, history, and targets', async () => {
        await workflows.notify('evening-review', english);
        await workflows.notify('evening-review', direct);
        expect(await definitions.workflow('evening-review')).toEqual({
          name: 'evening-review',
          title: 'Evening review',
          agent: 'coach',
          input: "Review today's chats.",
          history: {
            channels: [english],
            messages: 'people',
            hours: 12,
            runWhenEmpty: false,
          },
          targets: [direct, english],
          maxAttempts: 3,
          schedules: [],
          enabled: true,
        });
      });

      it('reads a Workflow that reads no history and notifies no one', async () => {
        expect(await definitions.workflow('brief')).toEqual({
          name: 'brief',
          title: null,
          agent: 'coach',
          input: 'Brief me.',
          history: null,
          targets: [],
          maxAttempts: 1,
          schedules: [],
          enabled: true,
        });
      });

      it('reads the enabled schedules of a Workflow, oldest first', async () => {
        await triggers.add({ workflow: 'brief', kind: 'manual' });
        await triggers.add({
          workflow: 'brief',
          kind: 'schedule',
          cron: '0 9 * * *',
          timezone: 'Europe/Berlin',
        });
        const off = await triggers.add({
          workflow: 'brief',
          kind: 'schedule',
          cron: '0 12 * * *',
          timezone: 'UTC',
        });
        await triggers.setEnabled(off.id, false);
        await triggers.add({
          workflow: 'brief',
          kind: 'schedule',
          cron: '0 18 * * 1-5',
          timezone: 'UTC',
        });
        await workflows.edit('brief', { enabled: false });

        const expected = [
          { cron: '0 9 * * *', timezone: 'Europe/Berlin' },
          { cron: '0 18 * * 1-5', timezone: 'UTC' },
        ];
        // A disabled Workflow keeps its schedules; their times pass unrun.
        expect((await definitions.workflow('brief'))?.schedules).toEqual(
          expected,
        );
        expect(
          (await definitions.workflows()).map(({ name, schedules }) => ({
            name,
            schedules,
          })),
        ).toEqual([
          { name: 'brief', schedules: expected },
          { name: 'evening-review', schedules: [] },
        ]);
      });

      it('finds a Workflow in any case, and none that does not exist', async () => {
        expect((await definitions.workflow('Brief'))?.name).toBe('brief');
        expect(await definitions.workflow('nothing')).toBeNull();
        await expect(requireWorkflow(definitions, 'nothing')).rejects.toThrow(
          new NotFoundError('No Workflow named nothing'),
        );
      });

      it('lists every Workflow by name, each with its own targets', async () => {
        await workflows.notify('brief', direct);
        await workflows.notify('evening-review', english);
        expect(
          (await definitions.workflows()).map(({ name, targets }) => ({
            name,
            targets,
          })),
        ).toEqual([
          { name: 'brief', targets: [direct] },
          { name: 'evening-review', targets: [english] },
        ]);
      });

      it('maps row IDs and names both ways', async () => {
        const id = await ids.workflowId('Brief');
        expect(await ids.workflowNames()).toEqual(
          new Map([
            [id, 'brief'],
            [await ids.workflowId('evening-review'), 'evening-review'],
          ]),
        );
        await expect(ids.workflowId('nothing')).rejects.toThrow(
          new NotFoundError('No Workflow named nothing'),
        );
      });
    });

    it('tells listeners when Workflows change', async () => {
      const ds = moduleRef.get<DataSource>(getDataSourceToken());
      const channels = ds.getRepository(Channel);
      const { id: channel } = await channels.save(
        channels.create({
          integrationKind: 'telegram',
          externalKey: '1234',
          address: { chatId: '1234' },
          title: null,
        }),
      );
      const listener = vi.fn();
      const stop = definitions.onChange(listener);

      await workflows.create({
        name: 'brief',
        agent: 'coach',
        inputTemplate: 'Brief me.',
      });
      await workflows.edit('brief', { enabled: false });
      await workflows.notify('brief', channel);
      await workflows.stopNotifying('brief', channel);
      expect(listener).toHaveBeenCalledTimes(4);

      // Its schedules are definitions too.
      const { id } = await triggers.add({
        workflow: 'brief',
        kind: 'schedule',
        cron: '0 9 * * *',
      });
      await triggers.setEnabled(id, false);
      await triggers.remove(id);
      expect(listener).toHaveBeenCalledTimes(7);

      // Nothing is told of a write that fails.
      await expect(
        workflows.edit('nothing', { enabled: false }),
      ).rejects.toThrow(NotFoundError);
      await expect(triggers.remove(id)).rejects.toThrow(NotFoundError);
      expect(listener).toHaveBeenCalledTimes(7);

      stop();
      await workflows.edit('brief', { enabled: true });
      expect(listener).toHaveBeenCalledTimes(7);
    });
  });
});
