import { setTimeout as sleep } from 'node:timers/promises';
import type { ControlClient } from '../control/client.js';
import { FINISHED_RUN_STATUSES, type RunView } from '../control/protocol.js';

/** How often a command asks whether a run has finished. */
const RUN_POLL_MS = 500;

/** Whether `run` has reached a status it does not leave. */
export function isFinished(run: RunView): boolean {
  return (FINISHED_RUN_STATUSES as readonly string[]).includes(run.status);
}

/** Asks the daemon about `run` until it has finished, and returns it then. */
export async function waitForRun(
  client: ControlClient,
  run: RunView,
): Promise<RunView> {
  while (!isFinished(run)) {
    await sleep(RUN_POLL_MS);
    run = await client.call('runs.get', { id: run.id });
  }
  return run;
}
