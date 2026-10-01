import { spawn } from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { WorkspaceLayout } from '../config/workspace-layout.js';
import { findRunningDaemon } from '../control/daemon-metadata.js';
import type { StatusResult } from '../control/protocol.js';
import { CliError } from './errors.js';

/** The compiled daemon entry point, next to the compiled CLI. */
export const DAEMON_MAIN = fileURLToPath(
  new URL('../daemon/main.js', import.meta.url),
);

export const READY_TIMEOUT_MS = 60_000;

/** How much of the daemon's own output a failed start shows. */
const MAX_OUTPUT_BYTES = 4096;

const POLL_INTERVAL_MS = 100;

/** How long each readiness probe waits for the control socket. */
const PROBE_TIMEOUT_MS = 1000;

export interface StartDaemonOptions {
  daemonMain?: string;
  readyTimeoutMs?: number;
}

export interface StartDaemonResult {
  /** False when a daemon was already running. */
  started: boolean;
  status: StatusResult;
}

/**
 * Ensures a daemon runs for `layout`. Starts one detached, in its own
 * session with output appended to `logs/daemon.out`, so it outlives this
 * process and its terminal; then waits until it answers as ready. Throws a
 * `CliError` with the daemon's output and log paths when it fails to start.
 */
export async function startDetachedDaemon(
  layout: WorkspaceLayout,
  options: StartDaemonOptions = {},
): Promise<StartDaemonResult> {
  const running = await findRunning(layout);
  if (running) return { started: false, status: running };

  const outputFile = layout.daemonOutputFile;
  const offset = fileSize(outputFile);
  const output = openSync(outputFile, 'a', 0o600);
  let child;
  try {
    child = spawn(
      process.execPath,
      [
        '--enable-source-maps',
        options.daemonMain ?? DAEMON_MAIN,
        '--workspace',
        layout.workspace,
      ],
      { detached: true, stdio: ['ignore', output, output] },
    );
  } finally {
    closeSync(output);
  }
  child.unref();

  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  child.once('exit', (code, signal) => (exit = { code, signal }));
  child.once('error', (error) => (spawnError = error));

  const timeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new CliError(`Cannot start Pero: ${spawnError.message}`);
    }
    if (exit) break;
    const running = await findRunningDaemon(layout.metadataFile, {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (running && running.metadata.pid === child.pid) {
      return { started: true, status: running.status };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!exit) {
    throw new CliError(
      `Pero did not become ready within ${timeoutMs / 1000} s (pid ${child.pid}); ` +
        `it may still be starting — check pero status.\n${logPaths(layout)}`,
    );
  }
  // Another `pero run` may have started one first.
  const other = await findRunning(layout);
  if (other) return { started: false, status: other };

  const reason = exit.signal
    ? `was killed by ${exit.signal}`
    : `exited with code ${exit.code}`;
  const printed = readFrom(outputFile, offset).trim();
  throw new CliError(
    `Pero failed to start: the daemon ${reason}.\n` +
      (printed ? `${printed}\n` : '') +
      logPaths(layout),
  );
}

/**
 * The daemon of `layout` once it answers as ready, as one a service
 * manager starts; null when none does within `timeoutMs`.
 */
export async function waitForDaemon(
  layout: WorkspaceLayout,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<StatusResult | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const running = await findRunning(layout);
    if (running || Date.now() >= deadline) return running;
    await sleep(POLL_INTERVAL_MS);
  }
}

async function findRunning(layout: WorkspaceLayout) {
  const running = await findRunningDaemon(layout.metadataFile, {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return running?.status ?? null;
}

function logPaths(layout: WorkspaceLayout): string {
  return `Logs: ${layout.logFile}, ${layout.daemonOutputFile}`;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** What was appended to `path` past `offset`, keeping the last part. */
function readFrom(path: string, offset: number): string {
  const size = fileSize(path);
  const start = Math.max(offset, size - MAX_OUTPUT_BYTES);
  if (size <= start) return '';
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8');
}
