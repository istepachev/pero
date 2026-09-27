import { resolve } from 'node:path';
import { Command } from 'nest-commander';
import { DaemonNotRunningError } from '../../control/client.js';
import { ControlError } from '../../control/protocol.js';
import { CliError } from '../errors.js';
import { PeroCommand } from '../pero-command.js';
import { restoreBackup } from '../restore.js';

@Command({
  name: 'restore',
  arguments: '<file>',
  description:
    'Restore a backup into a new or empty data directory while Pero is stopped',
  argsDescription: { file: 'archive written by pero backup' },
})
export class RestoreCommand extends PeroCommand {
  async run([file]: string[]): Promise<void> {
    const layout = this.layout();
    await this.refuseRunningDaemon(layout.root);

    const { dataDir, manifest, missing } = await restoreBackup(
      resolve(process.cwd(), file!),
      layout.root,
    );
    console.log(
      `Restored the backup from ${manifest.createdAt} (Pero ${manifest.peroVersion}) into ${dataDir}. ` +
        `Start it with pero run --data-dir ${dataDir}`,
    );
    for (const folder of missing) {
      const owner =
        folder.agent === null
          ? 'the default working directory'
          : `the working directory of Agent ${folder.agent}`;
      console.error(
        `Warning: ${folder.path}, ${owner}, is missing; restore it from your own backup of the working folders`,
      );
    }
  }

  /**
   * A friendly early check only: restoring into a missing or empty folder is
   * what guarantees that no daemon uses it.
   */
  private async refuseRunningDaemon(root: string): Promise<void> {
    try {
      await this.client().status();
    } catch (error) {
      // Nothing listening, or a socket that cannot exist here at all.
      if (error instanceof DaemonNotRunningError) return;
      if (error instanceof ControlError && error.code === 'connection') return;
      throw error;
    }
    throw new CliError(
      `Pero is running for ${root} — stop it with pero stop before restoring`,
    );
  }
}
