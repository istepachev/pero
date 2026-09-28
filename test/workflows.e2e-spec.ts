import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      nextRunAt: null,
      enabled: true,
    });
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
    ).toMatchObject({ id: daily.id, enabled: false });
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
    ).toEqual([{ ...daily, enabled: false }, manual]);
    expect(
      (await client.call('triggers.list', { workflow: 'evening-review' }))
        .triggers,
    ).toEqual([{ ...daily, enabled: false }, manual]);

    await client.call('workflows.edit', {
      name: 'evening-review',
      change: { enabled: true },
    });
    await client.call('triggers.setEnabled', { id: daily.id, enabled: true });
    expect(
      await client.call('workflows.get', { name: 'evening-review' }),
    ).toMatchObject({
      enabled: true,
      triggers: [{ id: daily.id, enabled: true }, { id: manual.id }],
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
});
