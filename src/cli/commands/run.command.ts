import { Command, Option } from 'nest-commander';
import { ensureDataDir } from '../../config/data-dir.js';
import { PeroCommand } from '../pero-command.js';
import { startDetachedDaemon } from '../start-daemon.js';

interface RunOptions {
  foreground?: boolean;
}

@Command({
  name: 'run',
  description: 'Start Pero in the background, or report the one running',
})
export class RunCommand extends PeroCommand {
  async run(_params: string[], options: RunOptions): Promise<void> {
    const config = this.config();
    if (options.foreground) {
      // Loaded only here: the daemon brings Nest, TypeORM, and SQLite.
      const { runDaemonProcess } = await import('../../daemon/process.js');
      await runDaemonProcess({ config, foreground: true });
    }

    const layout = ensureDataDir(config.dataDir);
    const { started, status } = await startDetachedDaemon(layout);
    console.log(
      `Pero is ${started ? 'running' : 'already running'} ` +
        `(pid ${status.pid}, data directory ${status.dataDir})`,
    );
    const pending = status.components
      .filter((component) => component.state !== 'ok')
      .map((component) => component.name);
    if (pending.length > 0) {
      console.log(`Needs setup: ${pending.join(', ')} — see pero status`);
    }
  }

  @Option({
    flags: '--foreground',
    description: 'run attached to this terminal, logging to stdout',
  })
  parseForeground(): boolean {
    return true;
  }
}
