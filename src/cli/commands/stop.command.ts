import { setTimeout as sleep } from 'node:timers/promises';
import { Command } from 'nest-commander';
import { STOP_DEADLINE_MS } from '../../common/shutdown.js';
import { describeLocation } from '../../config/data-dir.js';
import { DaemonNotRunningError } from '../../control/client.js';
import { CliError } from '../errors.js';
import { PeroCommand } from '../pero-command.js';

/** Extra wait past the daemon's own stop deadline before giving up. */
const STOP_SLACK_MS = 5000;

const POLL_INTERVAL_MS = 100;

@Command({ name: 'stop', description: 'Stop Pero and wait until it exits' })
export class StopCommand extends PeroCommand {
  async run(): Promise<void> {
    const layout = this.layout();
    const client = this.client();

    let pid: number;
    try {
      ({ pid } = await client.status());
    } catch (error) {
      if (!(error instanceof DaemonNotRunningError)) throw error;
      console.log(`Pero isn't running (${describeLocation(layout)})`);
      return;
    }

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
    console.log('Pero stopped');
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
