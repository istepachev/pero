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
   * A Workflow with one schedule Trigger, next due at `due`; the Trigger's
   * ID.
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
    await setDue(id, due);
    return id;
  }

  function setDue(id: number, due: string | Date): Promise<unknown> {
    return ds.getRepository(Trigger).update(id, { nextRunAt: new Date(due) });
  }

  function trigger(id: number): Promise<Trigger> {
    return ds.getRepository(Trigger).findOneByOrFail({ id });
  }

  function allRuns(): Promise<WorkflowRun[]> {
    return ds.getRepository(WorkflowRun).find({ order: { id: 'ASC' } });
  }

  it('queues one run for a schedule that has come due, and advances it', async () => {
    const id = await scheduled('brief', '2026-09-28T10:00:00Z');

    await scheduler.tick(new Date('2026-09-28T09:59:59Z'));
    expect(await allRuns()).toEqual([]);

    const now = new Date('2026-09-28T10:00:04Z');
    await scheduler.tick(now);
    await executor.idle();

    const runs = await allRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      triggerId: id,
      triggerKey: `schedule:${id}:2026-09-28T10:00:00.000Z`,
      status: 'completed',
      attempt: 1,
      skippedCount: 0,
      result: { text: 'echo: Run brief.' },
    });
    expect(await trigger(id)).toMatchObject({
      nextRunAt: new Date('2026-09-28T11:00:00Z'),
      lastRunAt: now,
    });
  });

  it('creates one run per time however often it polls', async () => {
    const id = await scheduled('brief', '2026-09-28T10:00:00Z');

    await scheduler.tick(new Date('2026-09-28T10:00:01Z'));
    await scheduler.tick(new Date('2026-09-28T10:00:01Z'));
    await scheduler.tick(new Date('2026-09-28T10:00:11Z'));
    expect(await allRuns()).toHaveLength(1);

    await scheduler.tick(new Date('2026-09-28T11:00:02Z'));
    await scheduler.tick(new Date('2026-09-28T11:00:12Z'));
    await executor.idle();
    expect((await allRuns()).map((run) => run.triggerKey)).toEqual([
      `schedule:${id}:2026-09-28T10:00:00.000Z`,
      `schedule:${id}:2026-09-28T11:00:00.000Z`,
    ]);
  });

  it('creates one run when polls overlap', async () => {
    const a = await scheduled('a', '2026-09-28T10:00:00Z');
    const b = await scheduled('b', '2026-09-28T10:00:00Z');

    const now = new Date('2026-09-28T10:00:01Z');
    await Promise.all([
      scheduler.tick(now),
      scheduler.tick(now),
      scheduler.tick(new Date('2026-09-28T10:00:05Z')),
    ]);
    await executor.idle();

    expect(
      (await allRuns()).map((run) => [run.triggerId, run.skippedCount]),
    ).toEqual([
      [a, 0],
      [b, 0],
    ]);
  });

  it('adds no run for a time that already has one', async () => {
    const id = await scheduled('brief', '2026-09-28T10:00:00Z');
    // As if the run was made, then the schedule restored from before it.
    await ds.getRepository(WorkflowRun).insert({
      workflowName: 'brief',
      triggerId: id,
      triggerKey: `schedule:${id}:2026-09-28T10:00:00.000Z`,
      status: 'completed',
    });

    await scheduler.tick(new Date('2026-09-28T10:00:01Z'));

    expect(await allRuns()).toHaveLength(1);
    expect((await trigger(id)).nextRunAt).toEqual(
      new Date('2026-09-28T11:00:00Z'),
    );
  });

  describe('missed times', () => {
    it('coalesces them into one catch-up run that records how many', async () => {
      const id = await scheduled('brief', '2026-09-28T10:00:00Z');

      const log = vi.spyOn(Logger.prototype, 'log');
      await scheduler.tick(new Date('2026-09-28T15:30:00Z'));
      await executor.idle();

      const runs = await allRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        triggerKey: `schedule:${id}:2026-09-28T10:00:00.000Z`,
        // 11:00 through 15:00.
        skippedCount: 5,
        status: 'completed',
      });
      expect(log).toHaveBeenCalledWith(
        `Run ${runs[0]!.id} of Workflow brief queued by schedule Trigger ${id} (caught up 5 missed times)`,
      );
      expect((await trigger(id)).nextRunAt).toEqual(
        new Date('2026-09-28T16:00:00Z'),
      );
    });

    it('stops counting them at the limit', async () => {
      const id = await scheduled('brief', '2025-09-28T10:00:00Z', '* * * * *');

      await scheduler.tick(new Date('2026-09-28T10:00:30Z'));
      await executor.idle();

      expect((await allRuns())[0]!.skippedCount).toBe(MAX_SKIPPED_COUNT);
      expect((await trigger(id)).nextRunAt).toEqual(
        new Date('2026-09-28T10:01:00Z'),
      );
    });

    it('creates exactly one catch-up run when Pero starts after downtime', async () => {
      const id = await scheduled('brief', new Date());
      await moduleRef.close();
      // Down since the top of the hour three hours ago.
      const lastHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
      const due = new Date(lastHour - 3 * HOUR_MS);
      const offline = await openDatabase(
        dataSourceOptions(join(tmp, 'pero.sqlite')),
      );
      await offline.getRepository(Trigger).update(id, { nextRunAt: due });
      await offline.destroy();

      // Startup polls at once, without waiting for the interval.
      await boot();
      await executor.idle();

      const runs = await allRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        triggerKey: `schedule:${id}:${due.toISOString()}`,
        skippedCount: 3,
        status: 'completed',
      });
      const { nextRunAt } = await trigger(id);
      expect(nextRunAt).toEqual(new Date(lastHour + HOUR_MS));

      await moduleRef.close();
      await boot();
      await executor.idle();
      expect(await allRuns()).toHaveLength(1);
    });
  });

  it('adds the times that come due while a run waits to start to its skipped count', async () => {
    const id = await scheduled('brief', '2026-09-28T10:00:00Z');
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
      [`schedule:${id}:2026-09-28T10:00:00.000Z`, 'running', 0],
      [`schedule:${id}:2026-09-28T11:00:00.000Z`, 'pending', 3],
    ]);
    expect((await trigger(id)).nextRunAt).toEqual(
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
    const id = await scheduled('brief', '2026-09-28T10:00:00Z');
    const { id: workflowId } = await workflows.get('brief');
    const { id: agentId } = await moduleRef.get(AgentsService).get('coach');

    await ds.getRepository(Workflow).update(workflowId, { enabled: false });
    await scheduler.tick(new Date('2026-09-28T10:00:01Z'));
    expect((await trigger(id)).nextRunAt).toEqual(
      new Date('2026-09-28T11:00:00Z'),
    );

    await ds.getRepository(Workflow).update(workflowId, { enabled: true });
    await ds.getRepository(Agent).update(agentId, { enabled: false });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockReturnValue();
    await scheduler.tick(new Date('2026-09-28T11:00:01Z'));
    expect(warn).toHaveBeenCalledWith(
      `Schedule Trigger ${id} of Workflow brief came due, but Agent coach is disabled; no run`,
    );
    expect((await trigger(id)).nextRunAt).toEqual(
      new Date('2026-09-28T12:00:00Z'),
    );

    // Enabled again, it runs from its next time, not the ones it passed.
    await ds.getRepository(Agent).update(agentId, { enabled: true });
    await scheduler.tick(new Date('2026-09-28T12:00:01Z'));
    await executor.idle();
    const runs = await allRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      triggerKey: `schedule:${id}:2026-09-28T12:00:00.000Z`,
      skippedCount: 0,
    });
  });

  it('ignores a disabled Trigger, even with a time saved', async () => {
    const id = await scheduled('brief', '2026-09-28T10:00:00Z');
    await ds.getRepository(Trigger).update(id, { enabled: false });

    await scheduler.tick(new Date('2026-09-28T10:00:01Z'));

    expect(await allRuns()).toEqual([]);
  });

  it('keeps starting other schedules when one cannot be read', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockReturnValue();
    const broken = await scheduled('broken', '2026-09-28T10:00:00Z');
    const fine = await scheduled('fine', '2026-09-28T10:00:00Z');
    await ds
      .getRepository(Trigger)
      .update(broken, { config: { cron: 'not a cron' } });

    await scheduler.tick(new Date('2026-09-28T10:00:01Z'));
    await executor.idle();

    expect((await allRuns()).map((run) => run.triggerId)).toEqual([fine]);
    expect((await trigger(broken)).nextRunAt).toEqual(
      new Date('2026-09-28T10:00:00Z'),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^Could not start schedule Trigger ${broken}: `),
      ),
    );
  });

  it('runs a local time the clocks skip the moment they jump', async () => {
    // 2026-03-29 in Berlin: 02:00 CET becomes 03:00 CEST (01:00Z).
    const id = await scheduled(
      'nightly',
      '2026-03-29T01:00:00Z',
      '30 2 * * *',
      'Europe/Berlin',
    );

    await scheduler.tick(new Date('2026-03-29T01:00:05Z'));
    await executor.idle();

    expect((await allRuns())[0]).toMatchObject({
      triggerKey: `schedule:${id}:2026-03-29T01:00:00.000Z`,
      skippedCount: 0,
    });
    expect((await trigger(id)).nextRunAt).toEqual(
      new Date('2026-03-30T00:30:00Z'), // 02:30 CEST
    );
  });
});
