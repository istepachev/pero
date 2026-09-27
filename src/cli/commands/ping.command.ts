import { Command } from 'nest-commander';
import { PeroCommand } from '../pero-command.js';

/** Checks that the daemon answers; hidden, for tests and troubleshooting. */
@Command({ name: 'ping', options: { hidden: true } })
export class PingCommand extends PeroCommand {
  async run(): Promise<void> {
    const { status } = await this.requireDaemon();
    console.log(`Pero is running (pid ${status.pid})`);
  }
}
