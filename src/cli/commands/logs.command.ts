import { statSync } from 'node:fs';
import { Command, Option } from 'nest-commander';
import { CliError } from '../errors.js';
import { formatLogLine } from '../format-log.js';
import { followFile, readLastLines } from '../log-file.js';
import { PeroCommand } from '../pero-command.js';

const DEFAULT_LINES = 50;

interface LogsOptions {
  lines?: number;
  follow?: boolean;
  json?: boolean;
}

/** Reads log files only: it needs no daemon and creates nothing. */
@Command({
  name: 'logs',
  description: 'Show recent daemon logs; --follow streams new entries',
})
export class LogsCommand extends PeroCommand {
  async run(_params: string[], options: LogsOptions): Promise<void> {
    const layout = this.layout();
    const print = (line: string) => {
      process.stdout.write(`${options.json ? line : formatLogLine(line)}\n`);
    };
    // `pero logs | head` closes the pipe early; that is not a failure.
    process.stdout.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') throw error;
      process.exit(0);
    });

    const recent = readLastLines(
      layout.logFile,
      options.lines ?? DEFAULT_LINES,
    );
    recent?.lines.forEach(print);

    if (!recent) {
      console.error(
        options.follow
          ? `Waiting for ${layout.logFile}…`
          : `No logs yet in ${layout.logs}`,
      );
    } else if (fileSize(layout.daemonOutputFile) > 0) {
      console.error(
        `Daemon output (startup errors, crashes): ${layout.daemonOutputFile}`,
      );
    }

    if (options.follow) {
      await followFile(layout.logFile, {
        from: recent?.end ?? 0,
        onLine: print,
      });
    }
  }

  @Option({
    flags: '-n, --lines <count>',
    description: `how many recent entries to show (default: ${DEFAULT_LINES})`,
  })
  parseLines(value: string): number {
    const count = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(count) || count < 1) {
      throw new CliError(
        `--lines must be a positive whole number, not "${value}"`,
      );
    }
    return count;
  }

  @Option({ flags: '-f, --follow', description: 'stream new entries' })
  parseFollow(): boolean {
    return true;
  }

  @Option({
    flags: '--json',
    description: 'print the raw JSON lines, for tools such as jq',
  })
  parseJson(): boolean {
    return true;
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
