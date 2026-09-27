import { type ChildProcess, execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataDirLayout, type DataDirLayout } from '../src/config/data-dir.js';
import { createControlClient } from '../src/control/client.js';
import {
  findRunningDaemon,
  readDaemonMetadata,
} from '../src/control/daemon-metadata.js';

// `npm run test:e2e` builds first.
const PERO = join(import.meta.dirname, '../bin/pero.js');
const DENY_DAEMON_DEPS = join(
  import.meta.dirname,
  'fixtures/deny-daemon-deps.mjs',
);

const NOT_RUNNING = "Pero isn't running — start it with pero run";

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe('pero CLI (e2e)', { timeout: 60_000 }, () => {
  let tmp: string;
  let layout: DataDirLayout;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    // Short: macOS limits socket paths to 104 bytes.
    tmp = mkdtempSync(join(tmpdir(), 'pero-'));
    layout = dataDirLayout(join(tmp, 'pero'));
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
    const metadata = readDaemonMetadata(layout.metadataFile);
    if (metadata) {
      kill(metadata.pid, 'SIGKILL');
      await vi.waitFor(() => expect(isAlive(metadata.pid)).toBe(false));
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Runs `pero` to completion; the environment carries no PERO_HOME. */
  function pero(
    args: string[],
    options: { env?: NodeJS.ProcessEnv; nodeArgs?: string[] } = {},
  ): Promise<Result> {
    const { PERO_HOME: _unset, ...env } = process.env;
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [...(options.nodeArgs ?? []), PERO, ...args],
        { env: { ...env, ...options.env } },
        (error, stdout, stderr) => {
          const code = error ? (error.code as number | null) : 0;
          resolve({ code, stdout, stderr });
        },
      );
    });
  }

  const withDataDir = (...args: string[]) => [
    '--data-dir',
    layout.root,
    ...args,
  ];

  it('runs once, reports status, and stops safely twice', async () => {
    const first = await pero(withDataDir('run'));
    expect(first).toMatchObject({ code: 0, stderr: '' });
    const pid = Number(/\(pid (\d+),/.exec(first.stdout)?.[1]);
    expect(first.stdout).toContain(
      `Pero is running (pid ${pid}, data directory ${layout.root})`,
    );
    expect(first.stdout).toContain(
      'Needs setup: claude, codex, telegram — see pero status',
    );

    const second = await pero(withDataDir('run'));
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`Pero is already running (pid ${pid},`);
    expect(readDaemonMetadata(layout.metadataFile)?.pid).toBe(pid);

    const status = await pero(withDataDir('status'));
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(new RegExp(`PID +${pid}\\n`));
    expect(status.stdout).toMatch(/Health +degraded/);
    for (const name of ['claude', 'codex', 'telegram']) {
      expect(status.stdout).toMatch(new RegExp(`${name} +unconfigured`));
    }

    const stop = await pero(withDataDir('stop'));
    expect(stop).toMatchObject({ code: 0, stdout: 'Pero stopped\n' });
    expect(isAlive(pid)).toBe(false);
    expect(readdirSync(layout.run)).toEqual(['pero.lock']);

    const again = await pero(withDataDir('stop'));
    expect(again).toMatchObject({
      code: 0,
      stdout: `Pero isn't running (data directory ${layout.root})\n`,
    });
  });

  it('keeps the daemon running after the CLI and its process group end', async () => {
    const cli = spawn(process.execPath, [PERO, ...withDataDir('run')], {
      detached: true,
      stdio: 'ignore',
    });
    children.push(cli);
    const code = await new Promise((resolve) => cli.once('exit', resolve));
    expect(code).toBe(0);

    // What closing a terminal does to the jobs it started.
    kill(-cli.pid!, 'SIGKILL');
    kill(-cli.pid!, 'SIGHUP');

    const running = await findRunningDaemon(layout.metadataFile);
    expect(running?.metadata.pid).not.toBe(cli.pid);
    await expect(
      createControlClient(layout.controlSocket).status(),
    ).resolves.toMatchObject({ pid: running?.metadata.pid });
  });

  it('fails a command that needs the daemon without starting one', async () => {
    const result = await pero(withDataDir('ping'));

    expect(result).toMatchObject({
      code: 1,
      stdout: '',
      stderr: `${NOT_RUNNING}\n`,
    });
    expect(existsSync(layout.controlSocket)).toBe(false);
    expect(existsSync(layout.metadataFile)).toBe(false);
  });

  it('reports status of a stopped daemon with exit code 3', async () => {
    const result = await pero(withDataDir('status'));

    expect(result).toMatchObject({
      code: 3,
      stderr: `Pero isn't running (data directory ${layout.root})\n`,
    });
  });

  it('prints why the daemon failed to start and where its logs are', async () => {
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.database, 'not a database'.repeat(100));

    const result = await pero(withDataDir('run'));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Pero failed to start: the daemon exited with code 1.',
    );
    expect(result.stderr).toContain('file is not a database');
    expect(result.stderr).toContain(
      `Logs: ${layout.logFile}, ${layout.daemonOutputFile}`,
    );
    expect(await findRunningDaemon(layout.metadataFile)).toBeNull();
  });

  it('runs in the foreground as one process until SIGTERM', async () => {
    const child = spawn(
      process.execPath,
      [PERO, 'run', '--foreground', ...withDataDir()],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    children.push(child);
    let stdout = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    const exited = new Promise((resolve) =>
      child.once('exit', (code) => resolve(code)),
    );

    await vi.waitFor(
      async () => {
        const running = await findRunningDaemon(layout.metadataFile);
        expect(running?.metadata.pid).toBe(child.pid);
      },
      { timeout: 20_000, interval: 50 },
    );
    const lines = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: 'Pero daemon started' }),
    );

    child.kill('SIGTERM');

    await expect(exited).resolves.toBe(0);
    expect(readdirSync(layout.run)).toEqual(['pero.lock']);
  });

  it('accepts the data directory before or after the command, or from PERO_HOME', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const pid = readDaemonMetadata(layout.metadataFile)?.pid;

    for (const result of [
      await pero(['status', '--data-dir', layout.root]),
      await pero(['status'], { env: { PERO_HOME: layout.root } }),
    ]) {
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(new RegExp(`PID +${pid}\\n`));
    }
  });

  it('never loads the database stack for status, ping, and stop', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const nodeArgs = ['--import', DENY_DAEMON_DEPS];

    for (const command of ['status', 'ping', 'stop']) {
      const result = await pero(withDataDir(command), { nodeArgs });
      expect(result, command).toMatchObject({ code: 0, stderr: '' });
    }
    // The hook itself works: the daemon cannot start under it.
    const foreground = await pero(withDataDir('run', '--foreground'), {
      nodeArgs,
    });
    expect(foreground.code).not.toBe(0);
    expect(foreground.stderr).toContain('The CLI must not load');
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Sends `signal`, ignoring a process or group that is already gone. */
function kill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
