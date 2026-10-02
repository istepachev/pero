import { homedir } from 'node:os';
import { Command, Option } from 'nest-commander';
import { ControlError } from '../../control/protocol.js';
import {
  checkWorkspace,
  type WorkspaceCheck,
} from '../../system-files/check.js';
import { formatCheck } from '../format-check.js';
import { PeroCommand } from '../pero-command.js';

interface CheckOptions {
  json?: boolean;
}

@Command({
  name: 'check',
  description:
    "Check the workspace's configuration: config.yaml, .env, and the system notes",
})
export class CheckCommand extends PeroCommand {
  async run(_args: string[], options: CheckOptions = {}): Promise<void> {
    const { workspace } = this.config();
    const result =
      (await this.checkThroughDaemon()) ??
      (await checkWorkspace({
        workspace,
        homeDir: homedir(),
        hostTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }));
    console.log(
      options.json
        ? JSON.stringify(
            { ok: result.problems.length === 0, ...result },
            null,
            2,
          )
        : formatCheck(result),
    );
    if (result.problems.length > 0) process.exitCode = 1;
  }

  /**
   * The running daemon's check, which also knows the topics Pero has
   * seen; null when Pero is stopped, or too old to check.
   */
  private async checkThroughDaemon(): Promise<WorkspaceCheck | null> {
    const daemon = await this.runningDaemon();
    if (daemon === null) return null;
    try {
      return await daemon.call('check');
    } catch (error) {
      if (error instanceof ControlError && error.code === 'unknown_operation') {
        return null;
      }
      throw error;
    }
  }

  @Option({
    flags: '--json',
    description: 'print the result as JSON, for tools',
  })
  parseJson(): boolean {
    return true;
  }
}
