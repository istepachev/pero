import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { AgentsService } from '../agents/agents.service.js';
import { NotFoundError } from '../common/errors.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { LegacyChannelAgent } from '../persistence/entities/legacy-channel-agent.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { TriggersModule } from '../triggers/triggers.module.js';
import { TriggersService } from '../triggers/triggers.service.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { DefinitionIds } from './definition-ids.js';
import { Definitions, requireAgent, requireWorkflow } from './definitions.js';
import { DefinitionsModule } from './definitions.module.js';
import { SqliteDefinitions } from './sqlite-definitions.js';

describe('SqliteDefinitions', () => {
  let tmp: string;
  let vault: string;
  let own: string;
  let moduleRef: TestingModule;
  let definitions: Definitions;
  let ids: DefinitionIds;
  let settings: SettingsService;
  let agents: AgentsService;
  let workflows: WorkflowsService;
  let triggers: TriggersService;

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
        WorkflowsModule,
        TriggersModule,
      ],
    }).compile();
    await moduleRef.init();
    definitions = moduleRef.get(Definitions);
    ids = moduleRef.get(DefinitionIds);
    settings = moduleRef.get(SettingsService);
    agents = moduleRef.get(AgentsService);
    workflows = moduleRef.get(WorkflowsService);
    triggers = moduleRef.get(TriggersService);
  });

  afterEach(async () => {
    await moduleRef.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('serves a legacy data directory', () => {
    expect(definitions).toBe(moduleRef.get(SqliteDefinitions));
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
      expect(await definitions.mainAgentName()).toBeNull();
      await settings.update({ mainAgent: 'notes' });
      expect((await definitions.mainAgent())?.name).toBe('notes');
      expect(await definitions.mainAgentName()).toBe('notes');
    });

    it('routes a Channel to the Agent its legacy row names', async () => {
      const ds = moduleRef.get<DataSource>(getDataSourceToken());
      const channels = ds.getRepository(Channel);
      const saved = await channels.save(
        ['1', '2', '3', '4', '5'].map((key) =>
          channels.create({
            integrationKind: 'telegram',
            externalKey: `-100:${key}`,
            address: { chatId: '-100', topicId: key },
            title: null,
          }),
        ),
      );
      const [coder, disabledChannel, disabledAgent, gone, none] = saved.map(
        (channel) => ({ id: channel.id, primary: false, title: null }),
      );
      await agents.edit('notes', { enabled: false });
      await ds.getRepository(LegacyChannelAgent).insert([
        { channelId: coder!.id, agentName: 'coder' },
        { channelId: disabledChannel!.id, agentName: 'coder', enabled: false },
        { channelId: disabledAgent!.id, agentName: 'notes' },
        { channelId: gone!.id, agentName: 'nobody' },
      ]);

      expect(await definitions.route(coder!)).toMatchObject({
        kind: 'agent',
        agent: { name: 'coder' },
      });
      expect(await definitions.route(disabledChannel!)).toEqual({
        kind: 'unanswered',
        reason: { kind: 'channel-disabled' },
      });
      expect(await definitions.route(disabledAgent!)).toEqual({
        kind: 'unanswered',
        reason: { kind: 'disabled', agent: 'notes', file: null },
      });
      expect(await definitions.route(gone!)).toEqual({
        kind: 'unanswered',
        reason: { kind: 'undefined-agent', agent: 'nobody' },
      });
      expect((await definitions.route(none!)).kind).toBe('unanswered');
    });
  });

  describe('with Workflows', () => {
    let english: number;
    let direct: number;

    beforeEach(async () => {
      await settings.update({ defaultWorkingDirectory: vault });
      await agents.create({ name: 'coach' });
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

  it('tells listeners when Workflows change', async () => {
    await settings.update({ defaultWorkingDirectory: vault });
    await agents.create({ name: 'coach' });
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
    definitions.onChange(listener);

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
    await expect(workflows.edit('nothing', { enabled: false })).rejects.toThrow(
      NotFoundError,
    );
    await expect(triggers.remove(id)).rejects.toThrow(NotFoundError);
    expect(listener).toHaveBeenCalledTimes(7);
  });
});
