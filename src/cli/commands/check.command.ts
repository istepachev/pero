import { homedir } from 'node:os';
import { Command, Option } from 'nest-commander';
import { checkWorkspace } from '../../settings-files/check.js';
import { CliError } from '../errors.js';
import { formatCheck } from '../format-check.js';
import { PeroCommand } from '../pero-command.js';

interface CheckOptions {
  json?: boolean;
}

@Command({
  name: 'check',
  description:
    "Check the workspace's configuration: config.yaml, .env, and the settings notes",
})
export class CheckCommand extends PeroCommand {
  async run(_args: string[], options: CheckOptions = {}): Promise<void> {
    const { workspace, dataDir } = this.config();
    if (workspace === null) {
      throw new CliError(
        `${dataDir} is a legacy data directory: its Agents and Workflows are in its database, and there are no notes to check`,
      );
    }
    const result = await checkWorkspace({
      workspace,
      homeDir: homedir(),
      hostTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
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

  @Option({
    flags: '--json',
    description: 'print the result as JSON, for tools',
  })
  parseJson(): boolean {
    return true;
  }
}
