import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsService } from '../agents/agents.service.js';
import { Agent } from '../persistence/entities/agent.entity.js';
import { ScheduleState } from '../persistence/entities/schedule-state.entity.js';
import { Trigger } from '../persistence/entities/trigger.entity.js';
import { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import { Workflow } from '../persistence/entities/workflow.entity.js';
import { dataSourceOptions } from '../persistence/data-source-options.js';
import { openDatabase } from '../persistence/open-database.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AGENT_RUNTIMES } from '../runtimes/agent-runtimes.js';
import { FakeAgentRuntime } from '../runtimes/testing/fake-agent-runtime.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { scheduleFingerprint } from '../triggers/schedule.js';
import { TriggersModule } from '../triggers/triggers.module.js';
import { TriggersService } from '../triggers/triggers.service.js';
import { WorkflowExecutor } from '../workflows/workflow-executor.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { MAX_SKIPPED_COUNT, ScheduleTick } from './schedule-tick.js';
import { SchedulerModule } from './scheduler.module.js';

const HOUR_MS = 60 * 60 * 1000;

describe('ScheduleTick', () => {
  let tmp: string;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let triggers: TriggersService;
  let workflows: WorkflowsService;
  let executor: WorkflowExecutor;
  let scheduler: ScheduleTick;
  let claude: FakeAgentRuntime;

  async function boot() {
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: join(tmp, 'pero.sqlite') }),
        SettingsModule,
        TriggersModule,
        SchedulerModule,
      ],
    })
      .overrideProvider(AGENT_RUNTIMES)
      .useValue([claude, new FakeAgentRuntime('codex')])
      .compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    triggers = moduleRef.get(TriggersService);
    workflows = moduleRef.get(WorkflowsService);
    executor = moduleRef.get(WorkflowExecutor);
    scheduler = moduleRef.get(ScheduleTick);
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-scheduler-'));
    const vault = join(tmp, 'vault');
    mkdirSync(vault);
    claude = new FakeAgentRuntime('claude');
    await boot();
    await moduleRef.get(SettingsService).update({
      defaultProvider: 'claude',
      defaultWorkingDirectory: vault,
    });
    await moduleRef.get(AgentsService).create({ name: 'coach' });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await moduleRef.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * A Workflow `name` with one schedule Trigger, next due at `due`; the
   * Trigger's ID.
   */
  async function scheduled(
    name: string,
    due: string | Date,
    cron = '0 * * * *',
    timezone = 'UTC',
  ): Promise<number> {
    await workflows.create({
      name,
      agent: 'coach',
      inputTemplate: `Run ${name}.`,
    });
    const { id } = await triggers.add({
      workflow: name,
      kind: 'schedule',
      cron,
      timezone,
    });
    await setDue(name, due);
    return id;
  }

  /** Makes the one schedule of Workflow `workflow` next due at `due`. */
  async function setDue(workflow: string, due: string | Date): Promise<void> {
    const { affected } = await ds
      .getRepository(ScheduleState)
      .update({ workflowName: workflow }, { nextRunAt: new Date(due) });
    expect(affected).toBe(1);
  }

  /** The saved times of the one schedule of Workflow `workflow`. */
  function state(workflow: string): Promise<ScheduleState> {
    return ds
      .getRepository(ScheduleState)
      .findOneByOrFail({ workflowName: workflow });
  }

  function allStates(): Promise<ScheduleState[]> {
    return ds
      .getRepository(ScheduleState)
      .find({ order: { workflowName: 'ASC', id: 'ASC' } });
  }

  function allRuns(): Promise<WorkflowRun[]> {
    return ds.getRepository(WorkflowRun).find({ order: { id: 'ASC' } });
  }

  it('queues one run for a schedule that has come due, and advances it', async () => {
    await scheduled('brief', '2026-09-28T10:00:00Z');

    await scheduler.tick(new Date('2026-09-28T09:59:59Z'));
    expect(await allRuns()).toEqual([]);

    const now = new Date('2026-09-28T10:00:04Z');
    await scheduler.tick(now);
    await executor.idle();

    const runs = await allRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      workflowName: 'brief',
      triggerId: null,
      triggerKey: `schedule:brief:2026-09-28T10:00:00.000Z`,
      status: 'completed',
      attempt: 1,
      skippedCount: 0,
      result: { text: 'echo: Run brief.' },
    });
    expect(await state('brief')).toMatchObject({
      nextRunAt: new Date('2026-09-28T11:00:00Z'),
      lastRunAt: now,
    });
  });

  it('creates one run per time however often it polls', async () => {
    await scheduled('brief', '2026-09-28T10:00:00Z');

    await scheduler.tick(new Date('2026-09-28T10:00:01Z'));
    await scheduler.tick(new Date('2026-09-28T10:00:01Z'));
    await scheduler.tick(new Date('2026-09-28T10:00:11Z'));
    expect(await allRuns()).toHaveLength(1);

    await scheduler.tick(new Date('2026-09-28T11:00:02Z'));
    await scheduler.tick(new Date('2026-09-28T11:00:12Z'));
    await executor.idle();
    expect((await allRuns()).map((run) => run.triggerKey)).toEqual([
      `schedule:brief:2026-09-28T10:00:00.000Z`,
      `schedule:brief:2026-09-28T11:00:00.000Z`,
    ]);
  });

  it('creates one run when polls overlap', async () => {
    await scheduled('a', '2026-09-28T10:00:00Z');
    await scheduled('b', '2026-09-28T10:00:00Z');

    const now = new Date('2026-09-28T10:00:01Z');
    await Promise.all([
      scheduler.tick(now),
      scheduler.tick(now),
      scheduler.tick(new Date('2026-09-28T10:00:05Z')),
    ]);
    await executor.idle();

    expect(
      (await allRuns()).map((run) => [run.workflowName, run.skippedCount]),
    ).toEqual([
      ['a', 0],
      ['b', 0],
    ]);
  });

  it('adds no run for a time that already has one', async () => {
    await scheduled('brief', '2026-09-28T10:00:00Z');
    // As if the run was made, then the schedule restored from before it.
    await ds.getRepository(WorkflowRun).insert({
      workflowName: 'brief',
      triggerKey: `schedule:brief:2026-09-28T10:00:00.000Z`,
      status: 'completed',
    });

    await scheduler.tick(new Date('2026-09-28T10:00:01Z'));

    expect(await allRuns()).toHaveLength(1);
    expect((await state('brief')).nextRunAt).toEqual(
      new Date('2026-09-28T11:00:00Z'),
    );
  });

  describe('missed times', () => {
    it('coalesces them into one catch-up run that records how many', async () => {
      await scheduled('brief', '2026-09-28T10:00:00Z');

      const log = vi.spyOn(Logger.prototype, 'log');
      await scheduler.tick(new Date('2026-09-28T15:30:00Z'));
      await executor.idle();

      const runs = await allRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        triggerKey: `schedule:brief:2026-09-28T10:00:00.000Z`,
        // 11:00 through 15:00.
        skippedCount: 5,
        status: 'completed',
      });
      expect(log).toHaveBeenCalledWith(
        `Run ${runs[0]!.id} of Workflow brief queued by its schedule 0 * * * * (UTC) (caught up 5 missed times)`,
      );
      expect((await state('brief')).nextRunAt).toEqual(
        new Date('2026-09-28T16:00:00Z'),
      );
    });

    it('stops counting them at the limit', async () => {
      await scheduled('brief', '2025-09-28T10:00:00Z', '* * * * *');

      await scheduler.tick(new Date('2026-09-28T10:00:30Z'));
      await executor.idle();

      expect((await allRuns())[0]!.skippedCount).toBe(MAX_SKIPPED_COUNT);
      expect((await state('brief')).nextRunAt).toEqual(
        new Date('2026-09-28T10:01:00Z'),
      );
    });

    it('creates exactly one catch-up run when Pero starts after downtime', async () => {
      await scheduled('brief', new Date());
      await moduleRef.close();
      // Down since the top of the hour three hours ago.
      const lastHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
      const due = new Date(lastHour - 3 * HOUR_MS);
      const offline = await openDatabase(
        dataSourceOptions(join(tmp, 'pero.sqlite')),
      );
      await offline
        .getRepository(ScheduleState)
        .update({ workflowName: 'brief' }, { nextRunAt: due });
      await offline.destroy();

      // Startup polls at once, without waiting for the interval.
      await boot();
      await executor.idle();

      const runs = await allRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        triggerKey: `schedule:brief:${due.toISOString()}`,
        skippedCount: 3,
        status: 'completed',
      });
      const { nextRunAt } = await state('brief');
      expect(nextRunAt).toEqual(new Date(lastHour + HOUR_MS));

      await moduleRef.close();
      await boot();
      await executor.idle();
      expect(await allRuns()).toHaveLength(1);
    });
  });

  it('neither loses nor repeats a run across the schedule state migration', async () => {
    const id = await scheduled('brief', new Date());
    await moduleRef.close();
    // As the release before left it, down since the top of the hour two
    // hours ago: the run before that queued by its Trigger, and the
    // Trigger's next run the first time missed.
    const lastHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const due = new Date(lastHour - 2 * HOUR_MS);
    const before = new Date(due.getTime() - HOUR_MS);
    const sqlTime = (date: Date) =>
      date.toISOString().replace('T', ' ').replace('Z', '');
    const offline = await openDatabase(
      dataSourceOptions(join(tmp, 'pero.sqlite')),
    );
    // Channel routes, then schedule state.
    await offline.undoLastMigration({ transaction: 'each' });
    await offline.undoLastMigration({ transaction: 'each' });
    await offline.query(
      `UPDATE "triggers" SET "next_run_at" = ?, "last_run_at" = ? WHERE "id" = ?`,
      [sqlTime(due), sqlTime(before), id],
    );
    await offline.query(
      `INSERT INTO "workflow_runs" ("workflow_name", "trigger_id", "trigger_key", "status") ` +
        `VALUES ('brief', ?, ?, 'completed')`,
      [id, `schedule:${id}:${before.toISOString()}`],
    );
    await offline.destroy();

    // Migrates, then catches up at once.
    await boot();
    await executor.idle();

    const runs = await allRuns();
    expect(
      runs.map((run) => [run.triggerKey, run.skippedCount, run.status]),
    ).toEqual([
      [`schedule:${id}:${before.toISOString()}`, 0, 'completed'],
      [`schedule:brief:${due.toISOString()}`, 2, 'completed'],
    ]);
    expect((await state('brief')).nextRunAt).toEqual(
      new Date(lastHour + HOUR_MS),
    );

    await moduleRef.close();
    await boot();
    await executor.idle();
    expect(await allRuns()).toHaveLength(2);
  });

  it('adds the times that come due while a run waits to start to its skipped count', async () => {
    await scheduled('brief', '2026-09-28T10:00:00Z');
    const held = claude.hold();

    await scheduler.tick(new Date('2026-09-28T10:00:01Z'));
    await held.started;
    // Waits: one run at a time per Workflow.
    await scheduler.tick(new Date('2026-09-28T11:00:01Z'));
    await scheduler.tick(new Date('2026-09-28T12:00:01Z'));
    // 13:00 is due, 14:00 missed.
    await scheduler.tick(new Date('2026-09-28T14:30:00Z'));

    const waiting = await allRuns();
    expect(
      waiting.map((run) => [run.triggerKey, run.status, run.skippedCount]),
    ).toEqual([
      [`schedule:brief:2026-09-28T10:00:00.000Z`, 'running', 0],
      [`schedule:brief:2026-09-28T11:00:00.000Z`, 'pending', 3],
    ]);
    expect((await state('brief')).nextRunAt).toEqual(
      new Date('2026-09-28T15:00:00Z'),
    );

    held.release();
    await executor.idle();
    expect((await allRuns()).map((run) => run.status)).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('passes times with no run while the Workflow or its Agent is disabled', async () => {
    await scheduled('brief', '2026-09-28T10:00:00Z');
    const { id: workflowId } = await workflows.get('brief');
    const { id: agentId } = await moduleRef.get(AgentsService).get('coach');

    await ds.getRepository(Workflow).update(workflowId, { enabled: false });
    await scheduler.tick(new Date('2026-09-28T10:00:01Z'));
    expect((await state('brief')).nextRunAt).toEqual(
      new Date('2026-09-28T11:00:00Z'),
    );

    await ds.getRepository(Workflow).update(workflowId, { enabled: true });
    await ds.getRepository(Agent).update(agentId, { enabled: false });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockReturnValue();
    await scheduler.tick(new Date('2026-09-28T11:00:01Z'));
    expect(warn).toHaveBeenCalledWith(
      `The schedule 0 * * * * (UTC) of Workflow brief came due, but Agent coach is disabled; no run`,
    );
    expect((await state('brief')).nextRunAt).toEqual(
      new Date('2026-09-28T12:00:00Z'),
    );

    // Enabled again, it runs from its next time, not the ones it passed.
    await ds.getRepository(Agent).update(agentId, { enabled: true });
    await scheduler.tick(new Date('2026-09-28T12:00:01Z'));
    await executor.idle();
    const runs = await allRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      triggerKey: `schedule:brief:2026-09-28T12:00:00.000Z`,
      skippedCount: 0,
    });
  });

  it('drops the saved times of a disabled Trigger, which starts nothing', async () => {
    const id = await scheduled('brief', '2026-09-28T10:00:00Z');
    // Behind the service's back, so only the tick can notice.
    await ds.getRepository(Trigger).update(id, { enabled: false });

    await scheduler.tick(new Date('2026-09-28T10:00:01Z'));

    expect(await allRuns()).toEqual([]);
    expect(await allStates()).toEqual([]);
  });

  it('drops the saved times of a schedule that is removed', async () => {
    const removed = await scheduled('removed', '2026-09-28T10:00:00Z');
    const deleted = await scheduled('deleted', '2026-09-28T10:00:00Z');
    await scheduled('kept', '2026-09-28T10:00:00Z');

    await triggers.remove(removed);
    expect((await allStates()).map((row) => row.workflowName)).toEqual([
      'deleted',
      'kept',
    ]);

    // Behind the service's back, so only the tick can notice.
    await ds.getRepository(Trigger).delete(deleted);
    const log = vi.spyOn(Logger.prototype, 'log');
    await scheduler.tick(new Date('2026-09-28T10:00:01Z'));
    await executor.idle();

    expect((await allStates()).map((row) => row.workflowName)).toEqual([
      'kept',
    ]);
    expect((await allRuns()).map((run) => run.workflowName)).toEqual(['kept']);
    expect(log).toHaveBeenCalledWith(
      'A schedule of Workflow deleted is no longer defined; its saved times are dropped',
    );
  });

  it('starts a changed schedule afresh, catching nothing up', async () => {
    const id = await scheduled('brief', '2026-09-28T10:00:00Z');
    // Changed while it was overdue, as a note may be while Pero is down.
    await ds
      .getRepository(Trigger)
      .update(id, { config: { cron: '30 * * * *' } });

    await scheduler.tick(new Date('2026-09-28T13:10:00Z'));

    expect(await allRuns()).toEqual([]);
    expect(await allStates()).toEqual([
      expect.objectContaining({
        workflowName: 'brief',
        fingerprint: scheduleFingerprint({
          cron: '30 * * * *',
          timezone: 'UTC',
        }),
        nextRunAt: new Date('2026-09-28T13:30:00Z'),
        lastRunAt: null,
      }),
    ]);

    await scheduler.tick(new Date('2026-09-28T13:30:01Z'));
    await executor.idle();
    expect(await allRuns()).toEqual([
      expect.objectContaining({
        triggerKey: 'schedule:brief:2026-09-28T13:30:00.000Z',
        skippedCount: 0,
      }),
    ]);
  });

  it('gives a schedule without saved times its first time from now', async () => {
    await scheduled('brief', '2026-09-28T10:00:00Z', '0 21 * * *');
    await ds.getRepository(ScheduleState).clear();

    await scheduler.tick(new Date('2026-09-28T22:00:00Z'));

    expect(await allRuns()).toEqual([]);
    expect((await state('brief')).nextRunAt).toEqual(
      new Date('2026-09-29T21:00:00Z'),
    );
  });

  it('keeps the times of each schedule of a Workflow with several', async () => {
    await scheduled('brief', '2026-09-28T09:00:00Z', '0 9 * * *');
    await triggers.add({
      workflow: 'brief',
      kind: 'schedule',
      cron: '0 18 * * *',
      timezone: 'UTC',
    });

    await scheduler.tick(new Date('2026-09-28T09:00:01Z'));
    await executor.idle();

    expect(
      (await allStates()).map((row) => [row.fingerprint, row.nextRunAt]),
    ).toEqual(
      expect.arrayContaining([
        [
          scheduleFingerprint({ cron: '0 9 * * *', timezone: 'UTC' }),
          new Date('2026-09-29T09:00:00Z'),
        ],
        [
          scheduleFingerprint({ cron: '0 18 * * *', timezone: 'UTC' }),
          expect.any(Date),
        ],
      ]),
    );
    expect((await allRuns()).map((run) => run.triggerKey)).toEqual([
      'schedule:brief:2026-09-28T09:00:00.000Z',
    ]);
  });

  it('queues one run for schedules of a Workflow due at the same time', async () => {
    await scheduled('brief', '2026-09-28T09:00:00Z', '0 9 * * *');
    await triggers.add({
      workflow: 'brief',
      kind: 'schedule',
      cron: '0 9 * * 1',
      timezone: 'UTC',
    });
    await ds
      .getRepository(ScheduleState)
      .update(
        { workflowName: 'brief' },
        { nextRunAt: new Date('2026-09-28T09:00:00Z') },
      );

    const now = new Date('2026-09-28T09:00:01Z');
    await scheduler.tick(now);
    await executor.idle();

    expect(
      (await allRuns()).map((run) => [run.triggerKey, run.skippedCount]),
    ).toEqual([['schedule:brief:2026-09-28T09:00:00.000Z', 0]]);
    expect((await allStates()).map((row) => row.lastRunAt)).toEqual([now, now]);
  });

  it('keeps starting other schedules when one cannot be computed', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockReturnValue();
    const broken = await scheduled('broken', '2026-09-28T10:00:00Z');
    await scheduled('fine', '2026-09-28T10:00:00Z');
    await ds
      .getRepository(Trigger)
      .update(broken, { config: { cron: 'not a cron' } });

    await scheduler.tick(new Date('2026-09-28T10:00:01Z'));
    await scheduler.tick(new Date('2026-09-28T10:00:11Z'));
    await executor.idle();

    expect((await allRuns()).map((run) => run.workflowName)).toEqual(['fine']);
    expect((await allStates()).map((row) => row.workflowName)).toEqual([
      'fine',
    ]);
    // Once, however many ticks find it.
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Could not schedule Workflow broken on not a cron \(UTC\): /,
      ),
    );
  });

  it('runs a local time the clocks skip the moment they jump', async () => {
    // 2026-03-29 in Berlin: 02:00 CET becomes 03:00 CEST (01:00Z).
    await scheduled(
      'nightly',
      '2026-03-29T01:00:00Z',
      '30 2 * * *',
      'Europe/Berlin',
    );

    await scheduler.tick(new Date('2026-03-29T01:00:05Z'));
    await executor.idle();

    expect((await allRuns())[0]).toMatchObject({
      triggerKey: `schedule:nightly:2026-03-29T01:00:00.000Z`,
      skippedCount: 0,
    });
    expect((await state('nightly')).nextRunAt).toEqual(
      new Date('2026-03-30T00:30:00Z'), // 02:30 CEST
    );
  });
});
