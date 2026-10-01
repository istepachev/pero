import { resolve } from 'node:path';
import { Command, Option } from 'nest-commander';
import { PeroCommand } from '../pero-command.js';

/** Copying a large database may take a while. */
const BACKUP_TIMEOUT_MS = 10 * 60_000;

@Command({
  name: 'backup',
  arguments: '<file>',
  description:
    'Write a backup of the state directory while Pero runs (the data folder only with --include-data)',
  argsDescription: { file: 'archive to write; an existing file is replaced' },
})
export class BackupCommand extends PeroCommand {
  async run(
    [file]: string[],
    options: { includeData?: boolean } = {},
  ): Promise<void> {
    await this.requireDaemon();
    const client = this.client({ timeoutMs: BACKUP_TIMEOUT_MS });
    const result = await client.call('backup.create', {
      file: resolve(process.cwd(), file!),
      ...(options.includeData ? { includeData: true } : {}),
    });
    console.log(
      `Backed up ${this.layout().stateDir}${result.includesData ? ' and the data folder' : ''} to ${result.file} (${formatBytes(result.bytes)})`,
    );
  }

  @Option({
    flags: '--include-data',
    description:
      'also back up the data folder, if it is not in Git or synced elsewhere',
  })
  parseIncludeData(): boolean {
    return true;
  }
}

/** `bytes` in the largest binary unit that keeps it at least 1. */
function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0
    ? `${value} ${units[0]}`
    : `${value.toFixed(1)} ${units[unit]}`;
}
