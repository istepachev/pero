import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleState } from '../persistence/entities/schedule-state.entity.js';
import { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import { Definitions } from '../definitions/definitions.js';
import { dataSourceOptions } from '../persistence/data-source-options.js';
import { openDatabase } from '../persistence/open-database.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AGENT_RUNTIMES } from '../runtimes/agent-runtimes.js';
import { FakeAgentRuntime } from '../runtimes/testing/fake-agent-runtime.js';
import { TestWorkspace } from '../settings-notes/testing/test-workspace.js';
import { type Schedule, scheduleFingerprint } from './schedule.js';
import { WorkflowExecutor } from '../workflows/workflow-executor.js';
import { MAX_SKIPPED_COUNT, ScheduleTick } from './schedule-tick.js';
import { SchedulerModule } from './scheduler.module.js';

const HOUR_MS = 60 * 60 * 1000;

describe('ScheduleTick', () => {
  let ws: TestWorkspace;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let executor: WorkflowExecutor;
  let scheduler: ScheduleTick;
  let claude: FakeAgentRuntime;

  async function boot() {
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: ws.database }),
        ws.hostConfig(),
        SchedulerModule,
      ],
    })
      .overrideProvider(AGENT_RUNTIMES)
      .useValue([claude, new FakeAgentRuntime('codex')])
      .compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    executor = moduleRef.get(WorkflowExecutor);
    scheduler = moduleRef.get(ScheduleTick);
    ws.use(moduleRef);
  }

  beforeEach(async () => {
    ws = TestWorkspace.create('pero-scheduler-');
    await ws.agent('Coach');
    claude = new FakeAgentRuntime('claude');
    await boot();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await moduleRef.close();
    ws.delete();
  });

  /**
   * A Workflow note `name` on the schedule `cron`, next due at `due`: the
   * scheduler gives it its saved times first, as its next tick would.
   */
  async function scheduled(
    name: string,
    due: string | Date,
    cron = '0 * * * *',
    timezone = 'UTC',
  ): Promise<void> {
    await ws.workflow(name, { agent: 'coach', cron, timezone });
    await reconcile();
    await setDue(name, due);
  }

  /** Gives each schedule its saved times, and queues nothing. */
  function reconcile(): Promise<void> {
    return scheduler.tick(new Date(0));
  }

  /**
   * Makes the definitions give Workflow `name` the schedules `schedules`
   * instead of its note's, as no note can.
   */
  function defineSchedules(name: string, schedules: Schedule[]): void {
    const definitions = moduleRef.get(Definitions);
    const workflows = definitions.workflows.bind(definitions);
    const workflow = definitions.workflow.bind(definitions);
    vi.spyOn(definitions, 'workflows').mockImplementation(async () =>
      (await workflows()).map((defined) =>
        defined.name === name ? { ...defined, schedules } : defined,
      ),
    );
    vi.spyOn(definitions, 'workflow').mockImplementation(async (wanted) => {
      const defined = await workflow(wanted);
      return defined?.name === name ? { ...defined, schedules } : defined;
    });
  }

  /**
   * Makes it `time` for the scheduler when it reconciles by itself, as on
   * a change of the notes.
   */
  function at(time: string): void {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(time) });
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
      const offline = await openDatabase(dataSourceOptions(ws.database));
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
    // The release before kept schedules as Triggers; the note says the same.
    await ws.workflow('brief', {
      agent: 'coach',
      cron: '0 * * * *',
      timezone: 'UTC',
    });
    await moduleRef.close();
    // As the release before left it, down since the top of the hour two
    // hours ago: the run before that queued by its Trigger, and the
    // Trigger's next run the first time missed.
    const lastHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const due = new Date(lastHour - 2 * HOUR_MS);
    const before = new Date(due.getTime() - HOUR_MS);
    const sqlTime = (date: Date) =>
      date.toISOString().replace('T', ' ').replace('Z', '');
    const offline = await openDatabase(dataSourceOptions(ws.database));
    // Back to before ScheduleState: it and the three migrations after it.
    for (let step = 0; step < 4; step++) {
      await offline.undoLastMigration({ transaction: 'each' });
    }
    const [{ id: workflowId }] = (await offline.query(
      `INSERT INTO "workflows" ("name", "agent_name", "input_template") ` +
        `VALUES ('brief', 'coach', 'Run brief.') RETURNING "id"`,
    )) as [{ id: number }];
    const [{ id }] = (await offline.query(
      `INSERT INTO "triggers" ("workflow_id", "kind", "config_json", "timezone", "next_run_at", "last_run_at") ` +
        `VALUES (?, 'schedule', '{"cron":"0 * * * *"}', 'UTC', ?, ?) RETURNING "id"`,
      [workflowId, sqlTime(due), sqlTime(before)],
    )) as [{ id: number }];
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

  it('passes times with no run while its Agent is disabled', async () => {
    await scheduled('brief', '2026-09-28T10:00:00Z');

    await ws.editAgent('Coach', { enabled: false });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockReturnValue();
    await scheduler.tick(new Date('2026-09-28T10:00:01Z'));
    expect(warn).toHaveBeenCalledWith(
      `The schedule 0 * * * * (UTC) of Workflow brief came due, but Agent coach is disabled; no run`,
    );
    expect((await state('brief')).nextRunAt).toEqual(
      new Date('2026-09-28T11:00:00Z'),
    );

    // Enabled again, it runs from its next time, not the ones it passed.
    await ws.editAgent('Coach', { enabled: true });
    await scheduler.tick(new Date('2026-09-28T11:00:01Z'));
    await executor.idle();
    const runs = await allRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      triggerKey: `schedule:brief:2026-09-28T11:00:00.000Z`,
      skippedCount: 0,
    });
  });

  it('drops the saved times of a schedule turned manual, which starts nothing', async () => {
    await scheduled('brief', '2026-09-28T10:00:00Z');
    await ws.editWorkflow('brief', { trigger: 'manual' });

    await scheduler.tick(new Date('2026-09-28T10:00:01Z'));

    expect(await allRuns()).toEqual([]);
    expect(await allStates()).toEqual([]);
  });

  it('drops the saved times of a schedule that is removed', async () => {
    await scheduled('removed', '2026-09-28T10:00:00Z');
    await scheduled('kept', '2026-09-28T10:00:00Z');

    await ws.removeWorkflow('removed');
    const log = vi.spyOn(Logger.prototype, 'log');
    await scheduler.tick(new Date('2026-09-28T10:00:01Z'));
    await executor.idle();

    expect((await allStates()).map((row) => row.workflowName)).toEqual([
      'kept',
    ]);
    expect((await allRuns()).map((run) => run.workflowName)).toEqual(['kept']);
    expect(log).toHaveBeenCalledWith(
      'A schedule of Workflow removed is no longer defined; its saved times are dropped',
    );
  });

  it('starts a changed schedule afresh, catching nothing up', async () => {
    await scheduled('brief', '2026-09-28T10:00:00Z');
    // Changed while it was overdue.
    at('2026-09-28T13:10:00Z');
    await ws.editWorkflow('brief', { cron: '30 * * * *' });

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
    defineSchedules('brief', [
      { cron: '0 9 * * *', timezone: 'UTC' },
      { cron: '0 18 * * *', timezone: 'UTC' },
    ]);

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
    defineSchedules('brief', [
      { cron: '0 9 * * *', timezone: 'UTC' },
      { cron: '0 9 * * 1', timezone: 'UTC' },
    ]);
    await reconcile();
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
    await scheduled('broken', '2026-09-28T10:00:00Z');
    await scheduled('fine', '2026-09-28T10:00:00Z');
    defineSchedules('broken', [{ cron: 'not a cron', timezone: 'UTC' }]);

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

  describe('reconciling with the notes', () => {
    it('moves the next run as soon as an edit changes the hour', async () => {
      at('2026-09-28T08:00:00Z');
      await ws.workflow('brief', { agent: 'coach', hour: 9, timezone: 'UTC' });
      await scheduler.reconciled();
      expect((await state('brief')).nextRunAt).toEqual(
        new Date('2026-09-28T09:00:00Z'),
      );

      at('2026-09-28T08:30:00Z');
      await ws.editWorkflow('brief', { hour: 10 });
      // Without waiting for a tick.
      await scheduler.reconciled();
      expect((await state('brief')).nextRunAt).toEqual(
        new Date('2026-09-28T10:00:00Z'),
      );

      await scheduler.tick(new Date('2026-09-28T09:00:01Z'));
      expect(await allRuns()).toEqual([]);
      await scheduler.tick(new Date('2026-09-28T10:00:01Z'));
      await executor.idle();
      expect((await allRuns()).map((run) => run.triggerKey)).toEqual([
        'schedule:brief:2026-09-28T10:00:00.000Z',
      ]);
    });

    it('cancels the waiting runs of a Workflow whose note is deleted, and lets a running one finish', async () => {
      await scheduled('brief', '2026-09-28T10:00:00Z');
      const held = claude.hold();
      await scheduler.tick(new Date('2026-09-28T10:00:01Z'));
      await held.started;
      await scheduler.tick(new Date('2026-09-28T11:00:01Z'));
      const [running, waiting] = await allRuns();
      expect([running!.status, waiting!.status]).toEqual([
        'running',
        'pending',
      ]);

      const log = vi.spyOn(Logger.prototype, 'log');
      await ws.removeWorkflow('brief');
      await scheduler.reconciled();

      expect(await allStates()).toEqual([]);
      expect(
        await ds
          .getRepository(WorkflowRun)
          .findOneByOrFail({ id: waiting!.id }),
      ).toMatchObject({
        status: 'cancelled',
        errorText:
          'Cancelled before it started: Workflow brief no longer exists',
        finishedAt: expect.any(Date),
      });
      expect(log).toHaveBeenCalledWith(
        `Run ${waiting!.id} of Workflow brief cancelled before it started: Workflow brief no longer exists`,
      );

      held.release();
      await executor.idle();
      expect((await allRuns()).map((run) => run.status)).toEqual([
        'completed',
        'cancelled',
      ]);
    });

    it('drops the saved times of a disabled Workflow and cancels the runs its schedule queued, not those started by hand', async () => {
      await scheduled('brief', '2026-09-28T10:00:00Z');
      const held = claude.hold();
      await scheduler.tick(new Date('2026-09-28T10:00:01Z'));
      await held.started;
      await scheduler.tick(new Date('2026-09-28T11:00:01Z'));
      await ds.getRepository(WorkflowRun).insert({
        workflowName: 'brief',
        triggerKey: 'manual:by-hand',
        status: 'pending',
      });

      const log = vi.spyOn(Logger.prototype, 'log');
      at('2026-09-28T11:10:00Z');
      await ws.editWorkflow('brief', { enabled: false });
      await scheduler.reconciled();

      expect(await allStates()).toEqual([]);
      expect(log).toHaveBeenCalledWith(
        'Workflow brief is disabled; the saved times of its schedule are dropped',
      );
      expect(
        (await allRuns()).map((run) => [run.triggerKey, run.status]),
      ).toEqual([
        ['schedule:brief:2026-09-28T10:00:00.000Z', 'running'],
        ['schedule:brief:2026-09-28T11:00:00.000Z', 'cancelled'],
        ['manual:by-hand', 'pending'],
      ]);
      await scheduler.tick(new Date('2026-09-28T12:00:01Z'));
      expect(await allRuns()).toHaveLength(3);

      held.release();
      await executor.idle();
      expect((await allRuns()).map((run) => run.status)).toEqual([
        'completed',
        'cancelled',
        'completed',
      ]);

      // Enabled again, it runs from its next time, not the ones it passed.
      at('2026-09-28T12:10:00Z');
      await ws.editWorkflow('brief', { enabled: true });
      await scheduler.reconciled();
      expect((await state('brief')).nextRunAt).toEqual(
        new Date('2026-09-28T13:00:00Z'),
      );
    });

    it('starts a renamed note on a schedule of its own', async () => {
      await scheduled('brief', '2026-09-28T10:00:00Z');
      await scheduler.tick(new Date('2026-09-28T10:00:01Z'));
      await executor.idle();

      at('2026-09-28T10:30:00Z');
      await ws.removeWorkflow('brief');
      await ws.workflow('daily', {
        agent: 'coach',
        cron: '0 * * * *',
        timezone: 'UTC',
      });
      await scheduler.reconciled();

      expect(await allStates()).toEqual([
        expect.objectContaining({
          workflowName: 'daily',
          nextRunAt: new Date('2026-09-28T11:00:00Z'),
          lastRunAt: null,
        }),
      ]);
    });

    it('catches up at startup only the notes that still exist and are enabled', async () => {
      await scheduled('kept', new Date());
      await scheduled('paused', new Date());
      await scheduled('removed', new Date());
      await moduleRef.close();
      // Down since the top of the hour three hours ago, and edited meanwhile.
      await ws.editWorkflow('paused', { enabled: false });
      await ws.removeWorkflow('removed');
      const lastHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
      const due = new Date(lastHour - 3 * HOUR_MS);
      const offline = await openDatabase(dataSourceOptions(ws.database));
      await offline
        .getRepository(ScheduleState)
        .createQueryBuilder()
        .update()
        .set({ nextRunAt: due })
        .execute();
      // Runs their schedules queued before Pero stopped.
      await offline.getRepository(WorkflowRun).insert(
        ['kept', 'paused', 'removed'].map((workflowName) => ({
          workflowName,
          triggerKey: `schedule:${workflowName}:${new Date(due.getTime() - HOUR_MS).toISOString()}`,
          status: 'pending' as const,
        })),
      );
      await offline.destroy();

      await boot();
      await executor.idle();

      expect(
        (await allRuns()).map((run) => [
          run.workflowName,
          run.status,
          run.skippedCount,
        ]),
      ).toEqual([
        ['kept', 'completed', 0],
        ['paused', 'cancelled', 0],
        ['removed', 'cancelled', 0],
        // One catch-up run for the three hours since.
        ['kept', 'completed', 3],
      ]);
      expect((await allStates()).map((row) => row.workflowName)).toEqual([
        'kept',
      ]);
    });
  });
});
