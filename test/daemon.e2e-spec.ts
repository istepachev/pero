import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import { createControlClient } from '../src/control/client.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';

describe('Daemon startup (e2e)', () => {
  let tmp: string;
  let dataDir: string;
  let daemon: Daemon | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-daemon-'));
    dataDir = join(tmp, 'pero');
  });

  afterEach(async () => {
    await daemon?.stop('test finished');
    daemon = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  function config() {
    return resolveBootstrapConfig({ dataDir, env: {} });
  }

  function logEntries(): Record<string, unknown>[] {
    return readFileSync(join(dataDir, 'logs', 'pero.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  const appliedMigration = expect.objectContaining({
    context: 'Persistence',
    msg: expect.stringMatching(/^Applied migration /),
  });

  it('creates the data directory layout and writes JSON logs', async () => {
    daemon = await startDaemon({ config: config(), foreground: false });

    for (const dir of ['logs', 'run', 'secrets']) {
      expect(statSync(join(dataDir, dir)).isDirectory()).toBe(true);
    }
    expect(statSync(join(dataDir, 'pero.sqlite')).isFile()).toBe(true);
    expect(statSync(join(dataDir, 'run', 'pero.sock')).isSocket()).toBe(true);
    expect(statSync(join(dataDir, 'run', 'pero.json')).isFile()).toBe(true);

    const entries = logEntries();
    expect(entries).toContainEqual(appliedMigration);
    expect(entries.at(-1)).toMatchObject({
      level: 30,
      msg: 'Pero daemon started',
      pid: process.pid,
      dataDir,
      socket: join(dataDir, 'run', 'pero.sock'),
    });
  });

  it('reuses the migrated database on the next start', async () => {
    const first = await startDaemon({ config: config(), foreground: false });
    await first.stop('test');
    const firstRun = logEntries().length;

    daemon = await startDaemon({ config: config(), foreground: false });

    const secondRun = logEntries().slice(firstRun);
    expect(secondRun).not.toContainEqual(appliedMigration);
    expect(secondRun.at(-1)).toMatchObject({ msg: 'Pero daemon started' });
    const client = createControlClient(join(dataDir, 'run', 'pero.sock'));
    await expect(client.status()).resolves.toMatchObject({ dataDir });
  });
});
