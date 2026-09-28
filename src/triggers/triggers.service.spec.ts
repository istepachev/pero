import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { AgentsService } from '../agents/agents.service.js';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from '../common/errors.js';
import { Trigger } from '../persistence/entities/trigger.entity.js';
import { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { TriggersModule } from './triggers.module.js';
import { TriggersService } from './triggers.service.js';

describe('TriggersService', () => {
  let tmp: string;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let settings: SettingsService;
  let triggers: TriggersService;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-triggers-'));
    const vault = join(tmp, 'vault');
    mkdirSync(vault);
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: join(tmp, 'pero.sqlite') }),
        SettingsModule,
        AgentsModule,
        TriggersModule,
      ],
    }).compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    settings = moduleRef.get(SettingsService);
    triggers = moduleRef.get(TriggersService);
    await settings.update({
      defaultWorkingDirectory: vault,
      timezone: 'Europe/Berlin',
    });
    await moduleRef.get(AgentsService).create({ name: 'coach' });
    const workflows = moduleRef.get(WorkflowsService);
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
  });

  afterEach(async () => {
    vi.useRealTimers();
    await moduleRef.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('adds a schedule in the installation time zone, copied when added', async () => {
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date('2026-09-28T12:00:00Z'),
    });
    const trigger = await triggers.add({
      workflow: 'Review',
      kind: 'schedule',
      cron: '0 21 * * *',
    });

    expect(trigger).toEqual({
      id: trigger.id,
      workflow: 'review',
      kind: 'schedule',
      cron: '0 21 * * *',
      timezone: 'Europe/Berlin',
      nextRunAt: '2026-09-28T19:00:00.000Z',
      lastRunAt: null,
      enabled: true,
    });

    await settings.update({ timezone: 'Asia/Tokyo' });
    expect((await triggers.list('review'))[0]!.timezone).toBe('Europe/Berlin');
  });

  it('keeps a time zone given for the schedule', async () => {
    const trigger = await triggers.add({
      workflow: 'review',
      kind: 'schedule',
      cron: '@daily',
      timezone: 'america/new_york',
    });

    expect(trigger).toMatchObject({
      cron: '@daily',
      timezone: 'America/New_York',
    });
  });

  it('adds a manual Trigger with no schedule or time zone', async () => {
    expect(await triggers.add({ workflow: 'review', kind: 'manual' })).toEqual(
      expect.objectContaining({
        kind: 'manual',
        cron: null,
        timezone: null,
        nextRunAt: null,
      }),
    );
  });

  it('refuses a second manual Trigger and an identical schedule', async () => {
    const manual = await triggers.add({ workflow: 'review', kind: 'manual' });
    const daily = await triggers.add({
      workflow: 'review',
      kind: 'schedule',
      cron: '0 21 * * *',
    });

    await expect(
      triggers.add({ workflow: 'review', kind: 'manual' }),
    ).rejects.toThrow(
      new ConflictError(
        `Workflow review already has a manual Trigger: Trigger ${manual.id}`,
      ),
    );
    await expect(
      triggers.add({
        workflow: 'review',
        kind: 'schedule',
        cron: '0  21 * * *',
        timezone: 'Europe/Berlin',
      }),
    ).rejects.toThrow(
      new ConflictError(
        `Workflow review already has this schedule: Trigger ${daily.id}`,
      ),
    );

    // The same schedule elsewhere, or in another zone, is a new one.
    await triggers.add({ workflow: 'brief', kind: 'manual' });
    await triggers.add({
      workflow: 'review',
      kind: 'schedule',
      cron: '0 21 * * *',
      timezone: 'UTC',
    });
    expect(await triggers.list()).toHaveLength(4);
  });

  it('refuses an unknown Workflow and an invalid schedule', async () => {
    await expect(
      triggers.add({ workflow: 'nothing', kind: 'manual' }),
    ).rejects.toThrow(new NotFoundError('No Workflow named nothing'));
    await expect(
      triggers.add({
        workflow: 'review',
        kind: 'schedule',
        cron: '0 25 * * *',
      }),
    ).rejects.toThrow(InvalidInputError);
    expect(await triggers.list()).toEqual([]);
  });

  it("lists every Trigger, or one Workflow's, by ID", async () => {
    const first = await triggers.add({ workflow: 'review', kind: 'manual' });
    const second = await triggers.add({ workflow: 'brief', kind: 'manual' });

    expect((await triggers.list()).map(({ id }) => id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(await triggers.list('brief')).toEqual([second]);
    await expect(triggers.list('nothing')).rejects.toThrow(NotFoundError);
  });

  it('disables and enables a Trigger', async () => {
    const { id } = await triggers.add({ workflow: 'review', kind: 'manual' });

    expect((await triggers.setEnabled(id, false)).enabled).toBe(false);
    expect((await triggers.list())[0]!.enabled).toBe(false);
    expect((await triggers.setEnabled(id, true)).enabled).toBe(true);
    await expect(triggers.setEnabled(id + 1, true)).rejects.toThrow(
      new NotFoundError(`No Trigger with ID ${id + 1}`),
    );
  });

  it("clears a schedule's next run when disabled and computes it from now when enabled", async () => {
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date('2026-09-28T12:00:00Z'),
    });
    const { id } = await triggers.add({
      workflow: 'review',
      kind: 'schedule',
      cron: '0 21 * * *',
    });

    expect(await triggers.setEnabled(id, false)).toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
    expect((await triggers.list())[0]!.nextRunAt).toBeNull();

    // Days later: the evenings it was disabled are not caught up.
    vi.setSystemTime(new Date('2026-10-02T20:00:00Z'));
    expect(await triggers.setEnabled(id, true)).toMatchObject({
      enabled: true,
      nextRunAt: '2026-10-03T19:00:00.000Z',
    });
    expect((await triggers.list())[0]!.nextRunAt).toBe(
      '2026-10-03T19:00:00.000Z',
    );

    // Enabling it again changes nothing, even once the run is overdue.
    vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
    expect((await triggers.setEnabled(id, true)).nextRunAt).toBe(
      '2026-10-03T19:00:00.000Z',
    );
  });

  it('refuses a schedule that never runs', async () => {
    await expect(
      triggers.add({
        workflow: 'review',
        kind: 'schedule',
        cron: '0 9 30 2 *',
      }),
    ).rejects.toThrow(
      new InvalidInputError(
        'cron: "0 9 30 2 *" never runs: no date matches it',
      ),
    );
    expect(await triggers.list()).toEqual([]);
  });

  it('schedules enabled schedules saved without a next run on startup', async () => {
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date('2026-09-28T12:00:00Z'),
    });
    const unscheduled = await triggers.add({
      workflow: 'review',
      kind: 'schedule',
      cron: '0 21 * * *',
    });
    const overdue = await triggers.add({
      workflow: 'brief',
      kind: 'schedule',
      cron: '0 7 * * *',
    });
    const disabled = await triggers.add({
      workflow: 'brief',
      kind: 'schedule',
      cron: '0 8 * * *',
    });
    await triggers.setEnabled(disabled.id, false);
    const manual = await triggers.add({ workflow: 'review', kind: 'manual' });
    const repo = ds.getRepository(Trigger);
    await repo.update(unscheduled.id, { nextRunAt: null });
    await repo.update(overdue.id, {
      nextRunAt: new Date('2026-09-28T05:00:00Z'),
    });

    await triggers.onApplicationBootstrap();

    const nextRuns = Object.fromEntries(
      (await triggers.list()).map((trigger) => [trigger.id, trigger.nextRunAt]),
    );
    expect(nextRuns).toEqual({
      [unscheduled.id]: '2026-09-28T19:00:00.000Z',
      // An overdue run is the scheduler's to catch up, not this.
      [overdue.id]: '2026-09-28T05:00:00.000Z',
      [disabled.id]: null,
      [manual.id]: null,
    });
  });

  it('removes a Trigger and keeps the runs it created', async () => {
    const trigger = await triggers.add({
      workflow: 'review',
      kind: 'schedule',
      cron: '0 21 * * *',
    });
    const runs = ds.getRepository(WorkflowRun);
    const run = await runs.save(
      runs.create({
        workflowId: (await moduleRef.get(WorkflowsService).get('review')).id,
        triggerId: trigger.id,
        triggerKey: 'schedule:2026-09-28T19:00:00Z',
      }),
    );

    expect(await triggers.remove(trigger.id)).toEqual(trigger);
    expect(await triggers.list()).toEqual([]);
    expect(await runs.findOneByOrFail({ id: run.id })).toMatchObject({
      triggerId: null,
      triggerKey: 'schedule:2026-09-28T19:00:00Z',
    });
    await expect(triggers.remove(trigger.id)).rejects.toThrow(NotFoundError);
  });
});
