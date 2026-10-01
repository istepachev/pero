import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBootstrapConfig } from '../src/config/bootstrap-config.js';
import {
  type WorkspaceLayout,
  workspaceLayout,
} from '../src/config/workspace-layout.js';
import { createControlClient } from '../src/control/client.js';
import {
  findRunningDaemon,
  readDaemonMetadata,
} from '../src/control/daemon-metadata.js';
import { type Daemon, startDaemon } from '../src/daemon/daemon.js';

// `npm run test:e2e` builds first.
const DAEMON_MAIN = join(import.meta.dirname, '../dist/daemon/main.js');

interface DaemonProcess {
  child: ChildProcess;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

describe('Daemon lifecycle (e2e)', { timeout: 30_000 }, () => {
  let tmp: string;
  let layout: WorkspaceLayout;
  let inProcess: Daemon | undefined;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    // Short: macOS limits socket paths to 104 bytes.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-')));
    layout = workspaceLayout(join(tmp, 'ws'));
  });

  afterEach(async () => {
    await inProcess?.stop('test finished');
    inProcess = undefined;
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  function startInProcess() {
    return startDaemon({
      config: resolveBootstrapConfig({
        workspace: layout.workspace,
        env: {},
      }),
      foreground: false,
    });
  }

  function spawnDaemon(): DaemonProcess {
    const child = spawn(
      process.execPath,
      [DAEMON_MAIN, '--workspace', layout.workspace],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    children.push(child);
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    return { child, stderr: () => stderr, exited };
  }

  /** Waits until the child answers as the daemon its metadata names. */
  async function ready({ child }: DaemonProcess) {
    await vi.waitFor(
      async () => {
        const running = await findRunningDaemon(layout.metadataFile);
        expect(running?.metadata.pid).toBe(child.pid);
      },
      { timeout: 20_000, interval: 50 },
    );
  }

  function logEntries(): Record<string, unknown>[] {
    return readFileSync(layout.logFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** Database closed, `run/` holding only the lock file, a final log line. */
  function expectCleanStop(pid: number | undefined) {
    expect(readdirSync(layout.run)).toEqual(['pero.lock']);
    // The last connection to close checkpoints and removes the WAL files.
    expect(existsSync(`${layout.database}-wal`)).toBe(false);
    expect(existsSync(`${layout.database}-shm`)).toBe(false);
    expect(logEntries().at(-1)).toMatchObject({
      msg: 'Pero daemon stopped',
      pid,
    });
  }

  it('refuses a second daemon on the same workspace', async () => {
    inProcess = await startInProcess();

    const second = spawnDaemon();

    await expect(second.exited).resolves.toEqual({ code: 1, signal: null });
    expect(second.stderr().trim()).toBe(
      `Pero is already running for workspace ${layout.workspace} (pid ${process.pid})`,
    );
    const client = createControlClient(layout.controlSocket);
    await expect(client.status()).resolves.toMatchObject({
      pid: process.pid,
    });
    expect(readDaemonMetadata(layout.metadataFile)?.pid).toBe(process.pid);
  });

  it('starts after a daemon was killed', async () => {
    const killed = spawnDaemon();
    await ready(killed);
    killed.child.kill('SIGKILL');
    await killed.exited;
    for (const file of [
      layout.controlSocket,
      layout.metadataFile,
      layout.lockFile,
      `${layout.database}-wal`,
    ]) {
      expect(existsSync(file)).toBe(true);
    }
    expect(await findRunningDaemon(layout.metadataFile)).toBeNull();

    inProcess = await startInProcess();

    const running = await findRunningDaemon(layout.metadataFile);
    expect(running?.metadata.pid).toBe(process.pid);
    expect(running?.status.pid).toBe(process.pid);
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'stops cleanly on %s',
    async (signal) => {
      const daemon = spawnDaemon();
      await ready(daemon);

      daemon.child.kill(signal);

      await expect(daemon.exited).resolves.toEqual({ code: 0, signal: null });
      expectCleanStop(daemon.child.pid);
    },
  );

  it('stops cleanly on a shutdown request', async () => {
    const daemon = spawnDaemon();
    await ready(daemon);

    await createControlClient(layout.controlSocket).shutdown();

    await expect(daemon.exited).resolves.toEqual({ code: 0, signal: null });
    expectCleanStop(daemon.child.pid);
  });
});
