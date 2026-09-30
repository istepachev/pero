import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInputError } from '../src/common/errors.js';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import {
  type ControlClient,
  createControlClient,
  DaemonNotRunningError,
} from '../src/control/client.js';
import {
  type Daemon,
  DaemonAlreadyRunningError,
  startDaemon,
} from '../src/daemon/daemon.js';
import { FakeBotApi } from '../src/telegram/testing/fake-bot-api.js';

const { version } = JSON.parse(
  readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'),
) as { version: string };

describe('Control endpoint (e2e)', () => {
  let tmp: string;
  let dataDir: string;
  let socketPath: string;
  let client: ControlClient;
  let app: Daemon | undefined;
  let api: FakeBotApi;

  beforeEach(async () => {
    api = new FakeBotApi();
    await api.listen();
    // Short: macOS limits socket paths to 104 bytes.
    tmp = mkdtempSync(join(tmpdir(), 'pero-'));
    dataDir = join(tmp, 'pero');
    socketPath = join(dataDir, 'run', 'pero.sock');
    client = createControlClient(socketPath);
  });

  afterEach(async () => {
    await app?.stop('test finished');
    app = undefined;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function start() {
    return startDaemon({
      config: resolveBootstrapConfig({ dataDir, env: {} }),
      foreground: false,
      // Telegram is the fake Bot API, never the real one.
      env: { PERO_TELEGRAM_API_ROOT: api.url },
    });
  }

  /** Requests shutdown and waits until the daemon has fully closed. */
  async function shutDown(daemon: Daemon) {
    const dataSource = daemon.app.get<DataSource>(getDataSourceToken());
    await client.shutdown();
    await expect(daemon.stopped).resolves.toEqual({ graceful: true });
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(join(dataDir, 'run', 'pero.json'))).toBe(false);
    expect(dataSource.isInitialized).toBe(false);
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
    // Only the default provider counts until an Agent uses another.
    expect(
      status.components.map(({ name, state, required }) => ({
        name,
        state,
        required,
      })),
    ).toEqual([
      { name: 'claude', state: 'unconfigured', required: true },
      { name: 'codex', state: 'unconfigured', required: false },
      { name: 'config', state: 'ok', required: true },
      // A legacy data directory, whose Agents and settings can't change.
      { name: 'settings', state: 'degraded', required: true },
      { name: 'telegram', state: 'unconfigured', required: true },
    ]);
  });

  it('checks provider sign-in on request', async () => {
    app = await start();

    const status = await client.call('providers.check');

    expect(status.components.find((c) => c.name === 'claude')).toMatchObject({
      state: 'unconfigured',
      detail: 'Not signed in — run claude auth login',
    });
  });

  it('changes the bot token, validating it first, and no other setting', async () => {
    const token = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';
    app = await start();
    const before = await client.call('settings.get');

    await expect(
      client.call('settings.update', { telegramBotToken: 'not a token' }),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      client.call('settings.update', {
        maxConcurrentRuns: 3,
        telegramBotToken: token,
      } as never),
    ).rejects.toThrow(InvalidInputError);
    expect(await client.call('settings.get')).toEqual(before);
    expect(readdirSync(join(dataDir, 'secrets'))).toEqual([]);

    const view = await client.call('settings.update', {
      telegramBotToken: token,
    });

    expect(view).toMatchObject({
      maxConcurrentRuns: before.maxConcurrentRuns,
      telegramBotToken: { set: true, source: 'secrets' },
    });
    expect(JSON.stringify(view)).not.toContain(token);
    await vi.waitFor(async () =>
      expect(
        (await client.status()).components.find((c) => c.name === 'telegram'),
      ).toMatchObject({
        // Until a chat is allowed.
        state: 'degraded',
        detail: expect.stringMatching(
          /^Connected as @pero_test_bot; no chat is allowed yet/,
        ),
      }),
    );
    expect(api.callsOf('getMe')[0]?.token).toBe(token);
    expect(JSON.stringify(await client.status())).not.toContain(token);
  });

  it('keeps running when Telegram rejects the bot token', async () => {
    const token = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';
    api.rejectToken(token);
    app = await start();

    await client.call('settings.update', { telegramBotToken: token });

    await vi.waitFor(async () =>
      expect(
        (await client.status()).components.find((c) => c.name === 'telegram'),
      ).toMatchObject({
        state: 'unconfigured',
        detail: 'Telegram rejected the bot token',
      }),
    );
    expect((await client.status()).pid).toBe(process.pid);
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
    const close = vi.spyOn(daemon.app, 'close');

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
    await daemon.stopped;
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

    await expect(start()).rejects.toThrow(DaemonAlreadyRunningError);
    await expect(start()).rejects.toThrow(
      `Pero is already running for data directory ${dataDir} (pid ${process.pid})`,
    );
    await expect(client.status()).resolves.toMatchObject({ dataDir });
  });
});
