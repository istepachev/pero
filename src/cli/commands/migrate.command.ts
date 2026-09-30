import { homedir } from 'node:os';
import { Command, CommandRunner } from 'nest-commander';
import { resolvePath, STATE_DIR_NAME } from '../../config/bootstrap-config.js';
import { CliError } from '../errors.js';
import { formatMigrate } from '../format-migrate.js';
import type { GlobalOptions } from '../global-options.js';

@Command({
  name: 'migrate',
  arguments: '<workspace>',
  description:
    'Convert a data directory (~/.pero, or --data-dir) into a workspace with notes, while Pero is stopped; the data directory is left as it is',
  argsDescription: { workspace: 'the workspace folder to make' },
})
export class MigrateCommand extends CommandRunner {
  async run([target]: string[]): Promise<void> {
    const { workspace, dataDir } =
      this.command.optsWithGlobals<GlobalOptions>();
    if (workspace !== undefined) {
      throw new CliError(
        'pero migrate takes the workspace as its argument, not --workspace; name the data directory with --data-dir',
      );
    }
    const home = homedir();
    const cwd = process.cwd();
    const source = resolvePath(
      dataDir ?? process.env.PERO_HOME ?? `~/${STATE_DIR_NAME}`,
      cwd,
      home,
    );
    // The database stack loads only here: every other command runs without it.
    const { migrateInstallation } =
      await import('../../migrate/migrate-installation.js');
    const result = await migrateInstallation({
      source,
      workspace: resolvePath(target!, cwd, home),
      homeDir: home,
      hostTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    console.log(formatMigrate(source, result));
    if (result.check.problems.length > 0) process.exitCode = 1;
  }
}
