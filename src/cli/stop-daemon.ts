import { setTimeout as sleep } from 'node:timers/promises';
import { STOP_DEADLINE_MS } from '../common/shutdown.js';
import type { WorkspaceLayout } from '../config/workspace-layout.js';
import {
  type ControlClient,
  DaemonNotRunningError,
} from '../control/client.js';
import { CliError } from './errors.js';

/** Extra wait past the daemon's own stop deadline before giving up. */
const STOP_SLACK_MS = 5000;

const POLL_INTERVAL_MS = 100;

/**
 * Asks the daemon `client` reaches, process `pid`, to stop, and waits
 * until it has exited.
 */
export async function stopDaemon(
  client: ControlClient,
  pid: number,
  layout: WorkspaceLayout,
): Promise<void> {
  try {
    await client.shutdown();
  } catch (error) {
    // The socket closes as soon as stopping begins; keep waiting.
    if (!(error instanceof DaemonNotRunningError)) throw error;
  }

  const waitMs = STOP_DEADLINE_MS + STOP_SLACK_MS;
  const deadline = Date.now() + waitMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new CliError(
        `Pero (pid ${pid}) did not stop within ${waitMs / 1000} s. ` +
          `Logs: ${layout.logFile}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
