import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import {
  type ControlClient,
  createControlClient,
  DaemonNotRunningError,
} from '../src/control/client.js';
import { ControlSocketError } from '../src/control/control-server.js';
import { startDaemon } from '../src/daemon/daemon.js';

const { version } = JSON.parse(
  readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'),
) as { version: string };

describe('Control endpoint (e2e)', () => {
  let tmp: string;
  let dataDir: string;
  let socketPath: string;
  let client: ControlClient;
  let app: INestApplicationContext | undefined;

  beforeEach(() => {
    // Short: macOS limits socket paths to 104 bytes.
    tmp = mkdtempSync(join(tmpdir(), 'pero-'));
    dataDir = join(tmp, 'pero');
    socketPath = join(dataDir, 'run', 'pero.sock');
    client = createControlClient(socketPath);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  function start() {
    return startDaemon({
      config: resolveBootstrapConfig({ dataDir, env: {} }),
      foreground: false,
    });
  }

  /** Requests shutdown and waits until the daemon has fully closed. */
  async function shutDown(daemon: INestApplicationContext) {
    const dataSource = daemon.get<DataSource>(getDataSourceToken());
    await client.shutdown();
    await vi.waitFor(() => {
      expect(existsSync(socketPath)).toBe(false);
      expect(dataSource.isInitialized).toBe(false);
    });
  }

  it('reports status through the client', async () => {
    app = await start();

    const status = await client.status();

    expect(status).toMatchObject({
      pid: process.pid,
      version,
      dataDir,
      uptimeMs: expect.any(Number),
    });
    expect(Date.parse(status.startedAt)).toBeLessThanOrEqual(Date.now());
  });

  it('is ready without Telegram or providers, reporting them unconfigured', async () => {
    app = await start();

    const status = await client.status();

    expect(status.health).toBe('degraded');
    expect(
      status.components.map(({ name, state }) => ({ name, state })),
    ).toEqual([
      { name: 'claude', state: 'unconfigured' },
      { name: 'codex', state: 'unconfigured' },
      { name: 'telegram', state: 'unconfigured' },
    ]);
  });

  it('keeps the socket from other users', async () => {
    app = await start();

    expect(statSync(socketPath).isSocket()).toBe(true);
    expect(statSync(socketPath).mode & 0o077).toBe(0);
    expect(statSync(join(dataDir, 'run')).mode & 0o077).toBe(0);
  });

  it('does not answer when migrations cannot run', async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'pero.sqlite'), 'not a database'.repeat(100));

    await expect(start()).rejects.toThrow();

    expect(existsSync(socketPath)).toBe(false);
    await expect(client.status()).rejects.toThrow(DaemonNotRunningError);
  });

  it('shuts down on request, closing the database and the socket', async () => {
    const daemon = await start();
    app = daemon;

    await shutDown(daemon);
    app = undefined;

    await expect(client.status()).rejects.toThrow(DaemonNotRunningError);
  });

  it('serves many clients at once and shuts down once', async () => {
    const daemon = await start();
    app = daemon;
    const close = vi.spyOn(daemon, 'close');

    const statuses = await Promise.all(
      Array.from({ length: 20 }, () => client.status()),
    );
    expect(statuses.every((status) => status.pid === process.pid)).toBe(true);

    // A request that arrives once closing has begun finds no daemon, which
    // `pero stop` treats as stopped.
    const results = await Promise.allSettled([
      client.shutdown(),
      client.shutdown(),
    ]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    await vi.waitFor(() => expect(existsSync(socketPath)).toBe(false));
    app = undefined;
    expect(close).toHaveBeenCalledOnce();
  });

  it('shuts down while a client holds an idle connection', async () => {
    const daemon = await start();
    app = daemon;
    const idle = connect(socketPath);
    idle.on('error', () => undefined);
    await new Promise((resolve) => idle.once('connect', resolve));

    await shutDown(daemon);
    app = undefined;

    expect(idle.destroyed || idle.readableEnded).toBe(true);
  });

  it('replaces a socket left behind by a killed daemon', async () => {
    mkdirSync(join(dataDir, 'run'), { recursive: true, mode: 0o700 });
    const holder = spawn(process.execPath, [
      '-e',
      `require('node:net').createServer().listen(process.argv[1], () => console.log('up'))`,
      socketPath,
    ]);
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.once('exit', resolve));
    expect(existsSync(socketPath)).toBe(true);

    app = await start();

    await expect(client.status()).resolves.toMatchObject({ dataDir });
  });

  it('refuses a second daemon on the same data directory', async () => {
    app = await start();

    await expect(start()).rejects.toThrow(ControlSocketError);
    await expect(start()).rejects.toThrow(
      `Pero is already running for ${dataDir}`,
    );
    await expect(client.status()).resolves.toMatchObject({ dataDir });
  });
});
