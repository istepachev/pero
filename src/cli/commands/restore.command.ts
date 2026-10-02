import { resolve } from 'node:path';
import { Command, Option } from 'nest-commander';
import type { WorkingDirectoryRef } from '../../backup/archive.js';
import { DaemonNotRunningError } from '../../control/client.js';
import { ControlError } from '../../control/protocol.js';
import { CliError } from '../errors.js';
import { PeroCommand } from '../pero-command.js';
import { restoreBackup, type RestoreResult } from '../restore.js';

@Command({
  name: 'restore',
  arguments: '<file>',
  description:
    'Restore a backup into a workspace without a database, such as a fresh clone, while Pero is stopped',
  argsDescription: { file: 'archive written by pero backup' },
})
export class RestoreCommand extends PeroCommand {
  async run(
    [file]: string[],
    options: { replaceConfig?: boolean } = {},
  ): Promise<void> {
    const { workspace } = this.layout();
    await this.refuseRunningDaemon(workspace);

    const result = await restoreBackup(
      resolve(process.cwd(), file!),
      workspace,
      {
        replaceConfig: options.replaceConfig ?? false,
      },
    );
    const { stateDir, manifest } = result;
    console.log(
      `Restored the backup from ${manifest.createdAt} (Pero ${manifest.peroVersion}) into ${stateDir}.`,
    );
    for (const line of describeRestore(result)) console.log(line);
    console.log(`Start it with pero run --workspace ${workspace}`);
    for (const folder of result.missing) {
      console.error(`Warning: ${describeMissing(folder)}`);
    }
  }

  @Option({
    flags: '--replace-config',
    description:
      "replace the workspace's config.yaml with the backup's instead of keeping it",
  })
  parseReplaceConfig(): boolean {
    return true;
  }

  /**
   * A friendly early check only: restoring into a missing or empty folder is
   * what guarantees that no daemon uses it.
   */
  private async refuseRunningDaemon(workspace: string): Promise<void> {
    try {
      await this.client().status();
    } catch (error) {
      // Nothing listening, or a socket that cannot exist here at all.
      if (error instanceof DaemonNotRunningError) return;
      if (error instanceof ControlError && error.code === 'connection') return;
      throw error;
    }
    throw new CliError(
      `Pero is running for workspace ${workspace} — stop it with pero stop before restoring`,
    );
  }
}

function describeMissing(folder: WorkingDirectoryRef): string {
  if (folder.agent === null) {
    return `${folder.path}, the data folder, is missing; restore it from your Git repository or your own backup`;
  }
  return `${folder.path}, the working directory of Channel note ${folder.agent}, is missing; restore it from your own backup of the working folders`;
}

/** What a restore into a workspace did beyond the database, line by line. */
function describeRestore(result: RestoreResult): string[] {
  const lines: string[] = [];
  const config = `${result.stateDir}/config.yaml`;
  if (result.config === 'kept') {
    lines.push(`Kept ${config}; the backup's was not used.`);
    if (result.notAllowed.length > 0) {
      lines.push(
        `The backup's config.yaml also allowed ${result.notAllowed.join(', ')}; allow them again with pero telegram allow <chat-id>.`,
      );
    }
  } else if (result.config === 'replaced') {
    lines.push(`Replaced ${config} with the backup's.`);
  }
  if (result.data !== null) {
    const { folder, copied, kept } = result.data;
    lines.push(
      `Restored ${copied} ${copied === 1 ? 'file' : 'files'} of the data folder into ${folder}` +
        (kept > 0 ? `, keeping ${kept} already there.` : '.'),
    );
  }
  return lines;
}
