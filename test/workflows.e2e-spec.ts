import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from '../src/common/errors.js';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import {
  type ControlClient,
  createControlClient,
} from '../src/control/client.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';
import { AgentManager } from '../src/agents/agent-manager.js';
import { AgentRuntimes } from '../src/runtimes/agent-runtimes.js';
import type { FakeAgentRuntime } from '../src/runtimes/testing/fake-agent-runtime.js';
import { FakeBotApi } from '../src/telegram/testing/fake-bot-api.js';

describe('Workflow and Trigger definitions (e2e)', () => {
  let tmp: string;
  let vault: string;
  let dataDir: string;
  let client: ControlClient;
  let daemon: Daemon | undefined;
  let api: FakeBotApi;

  beforeEach(async () => {
    api = new FakeBotApi();
    await api.listen();
    // Short: macOS limits socket paths to 104 bytes.
    tmp = mkdtempSync(join(tmpdir(), 'pero-'));
    dataDir = join(tmp, 'pero');
    vault = join(tmp, 'vault');
    mkdirSync(vault);
    client = createControlClient(join(dataDir, 'run', 'pero.sock'));
  });

  afterEach(async () => {
    await daemon?.stop('test finished');
    daemon = undefined;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function start() {
    daemon = await startDaemon({
      config: resolveBootstrapConfig({ dataDir, env: {} }),
      foreground: false,
      // Telegram is the fake Bot API and Agents echo: nothing real runs.
      env: { PERO_TELEGRAM_API_ROOT: api.url, PERO_FAKE_RUNTIME: 'echo' },
    });
  }

  async function restart() {
    await daemon!.stop('restart');
    daemon = undefined;
    await start();
  }

  /** The echo runtime Claude Agents use in the running daemon. */
  function claude(): FakeAgentRuntime {
    return daemon!.app.get(AgentRuntimes).get('claude') as FakeAgentRuntime;
  }

  /** An enabled Agent `coach` and Workflow `brief` that can be run by hand. */
  async function manualBrief(maxAttempts?: number) {
    await client.call('settings.update', { defaultWorkingDirectory: vault });
    await client.call('agents.create', { name: 'coach' });
    await client.call('workflows.create', {
      name: 'brief',
      agent: 'coach',
      inputTemplate: 'Summarize the day.',
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
    });
    await client.call('triggers.add', { workflow: 'brief', kind: 'manual' });
  }

  it('creates, edits, disables, and enables Workflows and their Triggers, keeping them across a restart', async () => {
    await start();
    await client.call('settings.update', {
      defaultWorkingDirectory: vault,
      timezone: 'Europe/Berlin',
    });
    await client.call('agents.create', { name: 'coach' });
    await client.call('agents.create', { name: 'editor' });

    const created = await client.call('workflows.create', {
      name: 'Evening-Review',
      agent: 'coach',
      inputTemplate: "Review today's chats.",
    });
    expect(created).toMatchObject({
      name: 'evening-review',
      title: null,
      agent: 'coach',
      enabled: true,
      triggers: [],
    });

    const edited = await client.call('workflows.edit', {
      name: 'evening-review',
      change: { title: 'Evening review', agent: 'editor' },
    });
    expect(edited).toMatchObject({ title: 'Evening review', agent: 'editor' });

    const daily = await client.call('triggers.add', {
      workflow: 'evening-review',
      kind: 'schedule',
      cron: '0 21 * * *',
    });
    expect(daily).toMatchObject({
      workflow: 'evening-review',
      kind: 'schedule',
      cron: '0 21 * * *',
      timezone: 'Europe/Berlin',
      enabled: true,
    });
    // 21:00 in Berlin, within the next day.
    const nextRun = new Date(daily.nextRunAt!);
    expect(nextRun.getTime()).toBeGreaterThan(Date.now());
    expect(nextRun.getTime() - Date.now()).toBeLessThanOrEqual(
      24 * 60 * 60 * 1000,
    );
    expect(
      nextRun.toLocaleTimeString('en-GB', { timeZone: 'Europe/Berlin' }),
    ).toBe('21:00:00');
    const manual = await client.call('triggers.add', {
      workflow: 'evening-review',
      kind: 'manual',
    });
    const weekly = await client.call('triggers.add', {
      workflow: 'evening-review',
      kind: 'schedule',
      cron: '@weekly',
      timezone: 'UTC',
    });

    expect(
      await client.call('triggers.setEnabled', {
        id: daily.id,
        enabled: false,
      }),
    ).toMatchObject({ id: daily.id, enabled: false, nextRunAt: null });
    expect(await client.call('triggers.remove', { id: weekly.id })).toEqual(
      weekly,
    );
    expect(
      await client.call('workflows.edit', {
        name: 'evening-review',
        change: { enabled: false },
      }),
    ).toMatchObject({ enabled: false });

    await restart();

    const { workflows } = await client.call('workflows.list');
    expect(workflows).toEqual([
      expect.objectContaining({
        name: 'evening-review',
        title: 'Evening review',
        agent: 'editor',
        inputTemplate: "Review today's chats.",
        enabled: false,
        triggerCount: 2,
      }),
    ]);
    expect(
      (await client.call('workflows.get', { name: 'evening-review' })).triggers,
    ).toEqual([{ ...daily, enabled: false, nextRunAt: null }, manual]);
    expect(
      (await client.call('triggers.list', { workflow: 'evening-review' }))
        .triggers,
    ).toEqual([{ ...daily, enabled: false, nextRunAt: null }, manual]);

    await client.call('workflows.edit', {
      name: 'evening-review',
      change: { enabled: true },
    });
    await client.call('triggers.setEnabled', { id: daily.id, enabled: true });
    expect(
      await client.call('workflows.get', { name: 'evening-review' }),
    ).toMatchObject({
      enabled: true,
      triggers: [
        { id: daily.id, enabled: true, nextRunAt: expect.any(String) },
        { id: manual.id },
      ],
    });
  });

  it('rejects invalid references and definitions', async () => {
    await start();
    await client.call('settings.update', { defaultWorkingDirectory: vault });
    await client.call('agents.create', { name: 'coach' });
    await client.call('agents.create', { name: 'idle' });
    await client.call('agents.edit', {
      name: 'idle',
      change: { enabled: false },
    });

    await expect(
      client.call('workflows.create', {
        name: 'review',
        agent: 'nobody',
        inputTemplate: 'Go',
      }),
    ).rejects.toThrow(new NotFoundError('No Agent named nobody'));
    await expect(
      client.call('workflows.create', {
        name: 'review',
        agent: 'idle',
        inputTemplate: 'Go',
      }),
    ).rejects.toThrow(
      new InvalidInputError(
        'Agent idle is disabled; enable it first with pero agents enable idle',
      ),
    );
    await expect(
      client.call('workflows.create', {
        name: 'review',
        agent: 'coach',
        inputTemplate: '  ',
      }),
    ).rejects.toThrow(
      new InvalidInputError('inputTemplate: must not be empty'),
    );

    await client.call('workflows.create', {
      name: 'review',
      agent: 'coach',
      inputTemplate: 'Go',
    });
    await expect(
      client.call('workflows.create', {
        name: 'review',
        agent: 'coach',
        inputTemplate: 'Go',
      }),
    ).rejects.toThrow(
      new ConflictError('A Workflow named review already exists'),
    );
    await expect(
      client.call('workflows.edit', {
        name: 'review',
        change: { agent: 'idle' },
      }),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      client.call('workflows.edit', { name: 'nothing', change: {} }),
    ).rejects.toThrow(new NotFoundError('No Workflow named nothing'));

    await expect(
      client.call('triggers.add', { workflow: 'nothing', kind: 'manual' }),
    ).rejects.toThrow(new NotFoundError('No Workflow named nothing'));
    await expect(
      client.call('triggers.add', {
        workflow: 'review',
        kind: 'schedule',
        cron: '0 9 * *',
      }),
    ).rejects.toThrow(/^cron: must be a cron expression of five fields/);
    await expect(
      client.call('triggers.add', {
        workflow: 'review',
        kind: 'schedule',
        cron: '0 9 * * *',
        timezone: 'Mars/Olympus',
      }),
    ).rejects.toThrow(
      new InvalidInputError(
        'timezone: must be an IANA time zone such as Europe/Berlin',
      ),
    );
    await expect(client.call('triggers.remove', { id: 99 })).rejects.toThrow(
      new NotFoundError('No Trigger with ID 99'),
    );
    await expect(
      client.call('triggers.setEnabled', { id: 99, enabled: false }),
    ).rejects.toThrow(NotFoundError);

    expect((await client.call('triggers.list', {})).triggers).toEqual([]);
    expect(
      (await client.call('workflows.list')).workflows.map(({ name }) => name),
    ).toEqual(['review']);
  });

  it('runs a Workflow by hand through its manual Trigger, away from every Channel', async () => {
    await start();
    await client.call('settings.update', { defaultWorkingDirectory: vault });
    await client.call('agents.create', { name: 'coach' });
    await client.call('workflows.create', {
      name: 'brief',
      agent: 'coach',
      inputTemplate: 'Summarize the day.',
    });

    await expect(
      client.call('workflows.run', { name: 'brief' }),
    ).rejects.toThrow(
      new InvalidInputError(
        'Workflow brief has no manual Trigger; add one with pero triggers add brief --manual',
      ),
    );
    await expect(
      client.call('workflows.run', { name: 'nothing' }),
    ).rejects.toThrow(new NotFoundError('No Workflow named nothing'));
    await expect(client.call('runs.get', { id: 99 })).rejects.toThrow(
      new NotFoundError('No run with ID 99'),
    );

    const trigger = await client.call('triggers.add', {
      workflow: 'brief',
      kind: 'manual',
    });
    const queued = await client.call('workflows.run', { name: 'brief' });
    expect(queued).toMatchObject({
      workflow: 'brief',
      triggerId: trigger.id,
      attempt: 1,
    });
    await vi.waitFor(async () => {
      expect(await client.call('runs.get', { id: queued.id })).toMatchObject({
        status: 'completed',
        result: 'echo: Summarize the day.',
        error: null,
      });
    });
    const [listed] = (await client.call('triggers.list', { workflow: 'brief' }))
      .triggers;
    expect(listed!.lastRunAt).not.toBeNull();
    // No Channel took part.
    expect((await client.call('channels.list')).channels).toEqual([]);

    await restart();
    expect(await client.call('runs.get', { id: queued.id })).toMatchObject({
      status: 'completed',
      result: 'echo: Summarize the day.',
    });
  });

  it('starts one catch-up run for the times a schedule missed while Pero was down', async () => {
    const HOUR_MS = 60 * 60 * 1000;
    await start();
    await client.call('settings.update', { defaultWorkingDirectory: vault });
    await client.call('agents.create', { name: 'coach' });
    await client.call('workflows.create', {
      name: 'hourly',
      agent: 'coach',
      inputTemplate: 'Check the inbox.',
    });
    const trigger = await client.call('triggers.add', {
      workflow: 'hourly',
      kind: 'schedule',
      cron: '0 * * * *',
      timezone: 'UTC',
    });

    // Down since the top of the hour three hours ago.
    await daemon!.stop('downtime');
    daemon = undefined;
    const lastHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const due = new Date(lastHour - 3 * HOUR_MS);
    const db = new Database(join(dataDir, 'pero.sqlite'));
    db.prepare(`UPDATE "triggers" SET "next_run_at" = ? WHERE "id" = ?`).run(
      due.toISOString().replace('T', ' ').replace('Z', ''),
      trigger.id,
    );
    db.close();

    await start();
    await vi.waitFor(async () => {
      expect(await client.call('runs.get', { id: 1 })).toMatchObject({
        workflow: 'hourly',
        triggerId: trigger.id,
        triggerKey: `schedule:${trigger.id}:${due.toISOString()}`,
        // The three hours since; the first missed time is the run itself.
        skippedCount: 3,
        status: 'completed',
        result: 'echo: Check the inbox.',
      });
    });
    const [listed] = (
      await client.call('triggers.list', { workflow: 'hourly' })
    ).triggers;
    expect(listed!.nextRunAt).toBe(new Date(lastHour + HOUR_MS).toISOString());
    expect(listed!.lastRunAt).not.toBeNull();

    await restart();
    await expect(client.call('runs.get', { id: 2 })).rejects.toThrow(
      new NotFoundError('No run with ID 2'),
    );
  });

  it('records a run Pero stopped as interrupted on the next start, and retries it as its Workflow allows', async () => {
    await start();
    await manualBrief(2);
    const held = claude().hold();
    const queued = await client.call('workflows.run', { name: 'brief' });
    const request = await held.started;

    // Stop with a short shutdown timeout, so the run is aborted mid-way.
    await daemon!.app.get(AgentManager).drain(10);
    expect(request.signal.aborted).toBe(true);
    await restart();

    await vi.waitFor(async () => {
      expect(
        await client.call('runs.get', { id: queued.id + 1 }),
      ).toMatchObject({
        workflow: 'brief',
        triggerId: queued.triggerId,
        triggerKey: `retry:${queued.id}`,
        attempt: 2,
        status: 'completed',
        result: 'echo: Summarize the day.',
      });
    });
    expect(await client.call('runs.get', { id: queued.id })).toMatchObject({
      status: 'interrupted',
      attempt: 1,
      result: null,
      error: `Pero stopped before the run finished; run ${queued.id + 1} retries it (attempt 2 of 2)`,
    });
    expect(
      (await client.call('workflows.get', { name: 'brief' })).maxAttempts,
    ).toBe(2);
  });

  it('cancels a run waiting to start at once, and a running one through its runtime', async () => {
    await start();
    await manualBrief();
    await client.call('settings.update', { maxConcurrentRuns: 1 });
    await client.call('workflows.create', {
      name: 'other',
      agent: 'coach',
      inputTemplate: 'Something else.',
    });
    await client.call('triggers.add', { workflow: 'other', kind: 'manual' });
    const held = claude().hold();
    const running = await client.call('workflows.run', { name: 'brief' });
    const request = await held.started;
    const waiting = await client.call('workflows.run', { name: 'other' });

    expect(await client.call('runs.cancel', { id: waiting.id })).toMatchObject({
      status: 'cancelled',
      startedAt: null,
      error: 'Cancelled with pero runs cancel',
    });
    expect(await client.call('runs.cancel', { id: running.id })).toMatchObject({
      status: 'running',
    });
    await vi.waitFor(async () => {
      expect(await client.call('runs.get', { id: running.id })).toMatchObject({
        status: 'cancelled',
        result: null,
        error: 'Cancelled with pero runs cancel',
      });
    });
    expect(request.signal.aborted).toBe(true);
    // The cancelled run never started.
    expect(claude().requests).toHaveLength(1);
    await expect(
      client.call('runs.cancel', { id: running.id }),
    ).rejects.toThrow(
      new ConflictError(`Run ${running.id} has already finished (cancelled)`),
    );

    await restart();
    expect(await client.call('runs.get', { id: running.id })).toMatchObject({
      status: 'cancelled',
    });
  });
});
