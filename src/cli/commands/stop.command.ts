import { Command } from 'nest-commander';
import { NoWorkspaceError } from '../../config/bootstrap-config.js';
import { DaemonNotRunningError } from '../../control/client.js';
import { PeroCommand } from '../pero-command.js';
import { stopDaemon } from '../stop-daemon.js';

@Command({ name: 'stop', description: 'Stop Pero and wait until it exits' })
export class StopCommand extends PeroCommand {
  async run(): Promise<void> {
    let layout;
    try {
      layout = this.layout();
    } catch (error) {
      // Nothing was ever started, so there is nothing to stop.
      if (!(error instanceof NoWorkspaceError)) throw error;
      console.log(`Pero isn't running. ${error.message}`);
      return;
    }
    const client = this.client();

    let pid: number;
    try {
      ({ pid } = await client.status());
    } catch (error) {
      if (!(error instanceof DaemonNotRunningError)) throw error;
      console.log(`Pero isn't running (workspace ${layout.workspace})`);
      return;
    }

    await stopDaemon(client, pid, layout);
    console.log('Pero stopped');
  }
}
