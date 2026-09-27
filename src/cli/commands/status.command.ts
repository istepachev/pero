import { Command } from 'nest-commander';
import { PACKAGE_VERSION } from '../../common/package-version.js';
import { DaemonNotRunningError } from '../../control/client.js';
import { CliError } from '../errors.js';
import { formatStatus } from '../format-status.js';
import { PeroCommand } from '../pero-command.js';

/** The LSB exit status for "program is not running". */
const NOT_RUNNING_EXIT_CODE = 3;

@Command({
  name: 'status',
  description: 'Show whether Pero is running and the state of its components',
})
export class StatusCommand extends PeroCommand {
  async run(): Promise<void> {
    try {
      const status = await this.client().status();
      console.log(formatStatus(status, PACKAGE_VERSION));
    } catch (error) {
      if (!(error instanceof DaemonNotRunningError)) throw error;
      throw new CliError(
        `Pero isn't running (data directory ${this.layout().root})`,
        NOT_RUNNING_EXIT_CODE,
      );
    }
  }
}
