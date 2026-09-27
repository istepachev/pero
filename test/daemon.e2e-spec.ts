import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import { startDaemon } from '../src/daemon/daemon.js';

describe('Daemon startup (e2e)', () => {
  let tmp: string;
  let dataDir: string;
  let app: NestFastifyApplication | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-daemon-'));
    dataDir = join(tmp, 'pero');
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  function config() {
    return resolveBootstrapConfig({ dataDir, env: { PERO_PORT: '0' } });
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
    app = await startDaemon({ config: config(), foreground: false });

    for (const dir of ['logs', 'run', 'secrets']) {
      expect(statSync(join(dataDir, dir)).isDirectory()).toBe(true);
    }
    expect(statSync(join(dataDir, 'pero.sqlite')).isFile()).toBe(true);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok' });

    const entries = logEntries();
    expect(entries).toContainEqual(appliedMigration);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 30,
        context: 'NestApplication',
        msg: 'Nest application successfully started',
      }),
    );
    expect(entries.at(-1)).toMatchObject({
      msg: 'Pero daemon started',
      pid: process.pid,
      dataDir,
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
    });
  });

  it('reuses the migrated database on the next start', async () => {
    app = await startDaemon({ config: config(), foreground: false });
    await app.close();
    const firstRun = logEntries().length;

    app = await startDaemon({ config: config(), foreground: false });

    const secondRun = logEntries().slice(firstRun);
    expect(secondRun).not.toContainEqual(appliedMigration);
    expect(secondRun.at(-1)).toMatchObject({ msg: 'Pero daemon started' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
