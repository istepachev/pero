import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { AgentsService } from '../agents/agents.service.js';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from '../common/errors.js';
import { Agent } from '../persistence/entities/agent.entity.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { TriggersModule } from '../triggers/triggers.module.js';
import { TriggersService } from '../triggers/triggers.service.js';
import { WorkflowViews } from './workflow-views.service.js';
import { WorkflowsModule } from './workflows.module.js';
import { WorkflowsService } from './workflows.service.js';

describe('WorkflowsService and WorkflowViews', () => {
  let tmp: string;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let agents: AgentsService;
  let workflows: WorkflowsService;
  let views: WorkflowViews;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-workflows-'));
    const vault = join(tmp, 'vault');
    mkdirSync(vault);
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: join(tmp, 'pero.sqlite') }),
        SettingsModule,
        AgentsModule,
        WorkflowsModule,
        TriggersModule,
      ],
    }).compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    agents = moduleRef.get(AgentsService);
    workflows = moduleRef.get(WorkflowsService);
    views = moduleRef.get(WorkflowViews);
    await moduleRef
      .get(SettingsService)
      .update({ defaultWorkingDirectory: vault });
    await agents.create({ name: 'coach' });
  });

  afterEach(async () => {
    await moduleRef.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a Workflow for an enabled Agent and shows it', async () => {
    await workflows.create({
      name: 'Evening-Review',
      title: 'Evening review',
      agent: 'COACH',
      inputTemplate: "Review today's chats.",
    });

    const details = await views.details('evening-review');
    expect(details).toMatchObject({
      name: 'evening-review',
      title: 'Evening review',
      agent: 'coach',
      agentEnabled: true,
      inputTemplate: "Review today's chats.",
      enabled: true,
      maxAttempts: 1,
      triggerCount: 0,
      triggers: [],
    });
    expect(await views.list()).toEqual([
      expect.objectContaining({ name: 'evening-review', triggerCount: 0 }),
    ]);
  });

  it('refuses an unknown or disabled Agent', async () => {
    await expect(
      workflows.create({
        name: 'review',
        agent: 'nobody',
        inputTemplate: 'Go',
      }),
    ).rejects.toThrow(new NotFoundError('No Agent named nobody'));

    await agents.edit('coach', { enabled: false });
    await expect(
      workflows.create({ name: 'review', agent: 'coach', inputTemplate: 'Go' }),
    ).rejects.toThrow(
      new InvalidInputError(
        'Agent coach is disabled; enable it first (enabled: true in its note)',
      ),
    );
    expect(await views.list()).toEqual([]);
  });

  it('refuses a name that is taken, in any case', async () => {
    await workflows.create({
      name: 'review',
      agent: 'coach',
      inputTemplate: 'Go',
    });

    await expect(
      workflows.create({ name: 'Review', agent: 'coach', inputTemplate: 'Go' }),
    ).rejects.toThrow(
      new ConflictError('A Workflow named review already exists'),
    );
  });

  it('changes the title, input, and Agent, and checks the new Agent', async () => {
    await agents.create({ name: 'editor' });
    await agents.create({ name: 'idle' });
    await agents.edit('idle', { enabled: false });
    await workflows.create({
      name: 'review',
      agent: 'coach',
      inputTemplate: 'Go',
    });

    await workflows.edit('REVIEW', {
      title: 'Review',
      agent: 'editor',
      inputTemplate: 'Go on',
    });
    expect(await views.details('review')).toMatchObject({
      title: 'Review',
      agent: 'editor',
      inputTemplate: 'Go on',
    });

    await workflows.edit('review', { title: null });
    expect((await views.details('review')).title).toBeNull();

    await expect(workflows.edit('review', { agent: 'idle' })).rejects.toThrow(
      InvalidInputError,
    );
    await expect(workflows.edit('review', { agent: 'nobody' })).rejects.toThrow(
      NotFoundError,
    );
    await expect(workflows.edit('missing', { title: 'x' })).rejects.toThrow(
      new NotFoundError('No Workflow named missing'),
    );
    expect((await views.details('review')).agent).toBe('editor');
  });

  it('sets how many times a run may start, from 1 to 10', async () => {
    await workflows.create({
      name: 'review',
      agent: 'coach',
      inputTemplate: 'Go',
      maxAttempts: 3,
    });
    expect((await views.details('review')).maxAttempts).toBe(3);

    await workflows.edit('review', { maxAttempts: 1 });
    expect((await views.details('review')).maxAttempts).toBe(1);

    await expect(workflows.edit('review', { maxAttempts: 0 })).rejects.toThrow(
      new InvalidInputError('maxAttempts: must be at least 1'),
    );
    await expect(workflows.edit('review', { maxAttempts: 11 })).rejects.toThrow(
      new InvalidInputError('maxAttempts: must be at most 10'),
    );
    await expect(
      workflows.create({
        name: 'other',
        agent: 'coach',
        inputTemplate: 'Go',
        maxAttempts: 1.5,
      }),
    ).rejects.toThrow(
      new InvalidInputError('maxAttempts: must be a whole number'),
    );
    expect((await views.details('review')).maxAttempts).toBe(1);
  });

  it('sets, changes, and clears the Channel history its runs read', async () => {
    const channels = ds.getRepository(Channel);
    const { id: channel } = await channels.save(
      channels.create({
        integrationKind: 'telegram',
        externalKey: '1234',
        address: { chatId: '1234' },
        title: null,
      }),
    );
    await workflows.create({
      name: 'plain',
      agent: 'coach',
      inputTemplate: 'Go',
    });
    expect((await views.details('plain')).history).toBeNull();

    await workflows.create({
      name: 'review',
      agent: 'coach',
      inputTemplate: 'Review {{history}}',
      history: {},
    });
    expect((await views.details('review')).history).toEqual({
      channels: 'all',
      messages: 'people',
      hours: null,
      runWhenEmpty: false,
    });

    // Fields left out keep their value.
    await workflows.edit('review', {
      history: { channels: [channel], hours: 12 },
    });
    await workflows.edit('review', { history: { runWhenEmpty: true } });
    expect((await views.details('review')).history).toEqual({
      channels: [channel],
      messages: 'people',
      hours: 12,
      runWhenEmpty: true,
    });

    await expect(
      workflows.edit('review', { history: { channels: [channel, 99] } }),
    ).rejects.toThrow(
      new InvalidInputError(
        'history.channels: no Channel with ID 99; pero channels ls lists them',
      ),
    );
    await expect(
      workflows.create({
        name: 'other',
        agent: 'coach',
        inputTemplate: 'Go',
        history: { channels: [98] },
      }),
    ).rejects.toThrow(InvalidInputError);

    await workflows.edit('review', { history: null });
    expect((await views.details('review')).history).toBeNull();
    // Without any history, edits start from the defaults.
    await workflows.edit('review', { history: { messages: 'all' } });
    expect((await views.details('review')).history).toEqual({
      channels: 'all',
      messages: 'all',
      hours: null,
      runWhenEmpty: false,
    });
  });

  it('disables and enables a Workflow, even while its Agent is disabled', async () => {
    await workflows.create({
      name: 'review',
      agent: 'coach',
      inputTemplate: 'Go',
    });

    await workflows.edit('review', { enabled: false });
    expect((await views.details('review')).enabled).toBe(false);

    await agents.edit('coach', { enabled: false });
    await workflows.edit('review', { enabled: true });
    expect(await views.details('review')).toMatchObject({
      enabled: true,
      agentEnabled: false,
    });
  });

  it('counts and lists Triggers with the Workflow', async () => {
    await workflows.create({
      name: 'review',
      agent: 'coach',
      inputTemplate: 'Go',
    });
    await workflows.create({
      name: 'brief',
      agent: 'coach',
      inputTemplate: 'Go',
    });
    const triggers = moduleRef.get(TriggersService);
    await triggers.add({ workflow: 'review', kind: 'manual' });
    await triggers.add({
      workflow: 'review',
      kind: 'schedule',
      cron: '0 21 * * *',
      timezone: 'UTC',
    });

    expect(
      (await views.list()).map(({ name, triggerCount }) => [
        name,
        triggerCount,
      ]),
    ).toEqual([
      ['brief', 0],
      ['review', 2],
    ]);
    expect((await views.details('review')).triggers).toEqual([
      expect.objectContaining({ kind: 'manual', cron: null }),
      expect.objectContaining({ kind: 'schedule', cron: '0 21 * * *' }),
    ]);
  });

  it('adds and removes the Channels a Workflow notifies', async () => {
    const channels = ds.getRepository(Channel);
    const [topic, direct] = await channels.save([
      channels.create({
        integrationKind: 'telegram',
        externalKey: '-100777:7',
        address: { chatId: '-100777', topicId: '7' },
        title: 'English',
      }),
      channels.create({
        integrationKind: 'telegram',
        externalKey: '1234',
        address: { chatId: '1234' },
        title: null,
      }),
    ]);
    await workflows.create({
      name: 'review',
      agent: 'coach',
      inputTemplate: 'Go',
    });
    expect((await views.details('review')).targets).toEqual([]);

    expect(await workflows.notify('Review', direct!.id)).toMatchObject({
      changed: true,
    });
    expect((await workflows.notify('review', topic!.id)).changed).toBe(true);
    expect((await workflows.notify('review', topic!.id)).changed).toBe(false);
    expect((await views.details('review')).targets).toEqual([
      {
        id: topic!.id,
        integrationKind: 'telegram',
        key: '-100777:7',
        title: 'English',
      },
      {
        id: direct!.id,
        integrationKind: 'telegram',
        key: '1234',
        title: null,
      },
    ]);

    expect((await workflows.stopNotifying('review', topic!.id)).changed).toBe(
      true,
    );
    expect((await workflows.stopNotifying('review', topic!.id)).changed).toBe(
      false,
    );
    expect((await views.details('review')).targets.map(({ id }) => id)).toEqual(
      [direct!.id],
    );

    await expect(workflows.notify('review', 99)).rejects.toThrow(
      new NotFoundError('No Channel with ID 99; pero channels ls lists them'),
    );
    await expect(workflows.stopNotifying('nope', topic!.id)).rejects.toThrow(
      new NotFoundError('No Workflow named nope'),
    );
  });

  it("names its Agent, so it outlives the Agent's row", async () => {
    await workflows.create({
      name: 'Review',
      agent: 'Coach',
      inputTemplate: 'Go',
    });

    await ds.getRepository(Agent).delete({ name: 'coach' });
    expect(await workflows.get('review')).toMatchObject({ agentName: 'coach' });
  });
});
