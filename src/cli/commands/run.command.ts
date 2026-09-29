import { homedir } from 'node:os';
import { Command, Option } from 'nest-commander';
import { ensureDataDir } from '../../config/data-dir.js';
import { ControlError } from '../../control/protocol.js';
import { CliError } from '../errors.js';
import { PeroCommand } from '../pero-command.js';
import { isInteractive, isPromptExit, terminalPrompts } from '../prompts.js';
import {
  fetchTelegramChats,
  formatPendingSetup,
  pendingSetup,
} from '../setup/pending-setup.js';
import { startDetachedDaemon } from '../start-daemon.js';

/** Provider CLIs may take a while to report their sign-in. */
const SETUP_TIMEOUT_MS = 60_000;

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

    const layout = ensureDataDir(config.dataDir, config.workspace);
    const { started, status } = await startDetachedDaemon(layout);
    const where =
      typeof status.workspace === 'string'
        ? `workspace ${status.workspace}`
        : `data directory ${status.dataDir}`;
    console.log(
      `Pero is ${started ? 'running' : 'already running'} ` +
        `(pid ${status.pid}, ${where})`,
    );
    await this.setUp(status.version);
  }

  /**
   * Finds what is still missing. On a terminal it guides the owner through
   * it; otherwise it prints what to set and returns without reading input.
   */
  private async setUp(daemonVersion: string): Promise<void> {
    const client = this.client({ timeoutMs: SETUP_TIMEOUT_MS });
    let state;
    try {
      const [status, settings] = await Promise.all([
        client.call('providers.check'),
        client.call('settings.get'),
      ]);
      state = { status, settings };
    } catch (error) {
      if (!(
        error instanceof ControlError && error.code === 'unknown_operation'
      )) {
        throw error;
      }
      console.log(
        `The running Pero is version ${daemonVersion}; restart it to set it up (pero stop, then pero run).`,
      );
      return;
    }

    const chats = await fetchTelegramChats(client);
    const pending = pendingSetup(state.status, state.settings, chats);
    if (pending.length === 0) return;
    if (!isInteractive()) {
      console.log(formatPendingSetup(pending));
      return;
    }

    const { runInteractiveSetup } =
      await import('../setup/interactive-setup.js');
    try {
      await runInteractiveSetup(
        {
          client,
          prompts: await terminalPrompts(),
          cwd: process.cwd(),
          home: homedir(),
          print: (text) => console.log(text),
        },
        state,
      );
    } catch (error) {
      if (!isPromptExit(error)) throw error;
      throw new CliError(
        'Setup interrupted; Pero keeps running. Run pero run to continue.',
        130,
      );
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
