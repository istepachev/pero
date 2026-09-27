import { resolve } from 'node:path';
import { Command } from 'nest-commander';
import { PeroCommand } from '../pero-command.js';

/** Copying a large database may take a while. */
const BACKUP_TIMEOUT_MS = 10 * 60_000;

@Command({
  name: 'backup',
  arguments: '<file>',
  description:
    'Write a backup of the data directory while Pero runs (working folders are not included)',
  argsDescription: { file: 'archive to write; an existing file is replaced' },
})
export class BackupCommand extends PeroCommand {
  async run([file]: string[]): Promise<void> {
    await this.requireDaemon();
    const client = this.client({ timeoutMs: BACKUP_TIMEOUT_MS });
    const result = await client.call('backup.create', {
      file: resolve(process.cwd(), file!),
    });
    console.log(
      `Backed up ${this.layout().root} to ${result.file} (${formatBytes(result.bytes)})`,
    );
    if (result.includesSecrets) {
      console.log(
        'It contains the Telegram bot token; keep it private, like the data directory.',
      );
    }
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
