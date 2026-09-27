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

  it('creates the data directory layout and writes JSON logs', async () => {
    const config = resolveBootstrapConfig({
      dataDir,
      env: { PERO_PORT: '0' },
    });

    app = await startDaemon({ config, foreground: false });

    for (const dir of ['logs', 'run', 'secrets']) {
      expect(statSync(join(dataDir, dir)).isDirectory()).toBe(true);
    }
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok' });

    const entries = readFileSync(join(dataDir, 'logs', 'pero.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
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
});
