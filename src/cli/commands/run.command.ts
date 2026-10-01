import { Command, Option } from 'nest-commander';
import { FAKE_RUNTIME_ENV } from '../../config/daemon-env.js';
import { ensureWorkspaceLayout } from '../../config/workspace-layout.js';
import { ControlError } from '../../control/protocol.js';
import { execCommand } from '../../providers/provider-auth.js';
import { CliError } from '../errors.js';
import { PeroCommand } from '../pero-command.js';
import {
  isInteractive,
  isPromptExit,
  type Prompts,
  terminalPrompts,
} from '../prompts.js';
import {
  formatRunning,
  localService,
  startAsService,
} from '../run-as-service.js';
import { BlockOutput } from '../setup/block-output.js';
import { configOrNewWorkspace } from '../setup/first-run.js';
import {
  fetchTelegramChats,
  formatPendingSetup,
  pendingSetup,
} from '../setup/pending-setup.js';
import { stopOnAbort } from '../setup/stop-on-abort.js';
import { startDetachedDaemon } from '../start-daemon.js';
import { stopDaemon } from '../stop-daemon.js';
import { isServiceInstalled, type SystemService } from '../system-service.js';

/** Provider CLIs may take a while to report their sign-in. */
const SETUP_TIMEOUT_MS = 60_000;

const INTERRUPTED_STOPPED =
  'Setup interrupted; Pero was stopped. Run pero run to set it up.';

const INTERRUPTED_RUNNING =
  'Setup interrupted; Pero keeps running. Run pero run to continue.';

interface RunOptions {
  foreground?: boolean;
}

@Command({
  name: 'run',
  description: 'Start Pero in the background, or report the one running',
})
export class RunCommand extends PeroCommand {
  async run(_params: string[], options: RunOptions): Promise<void> {
    const interactive = isInteractive();
    const output = new BlockOutput((text) => console.log(text));
    const prompts = async () => output.prompts(await terminalPrompts());
    const { config, firstRun } = await configOrNewWorkspace({
      config: () => this.config(),
      interactive,
      prompts,
      print: output.print,
      block: output.block,
      checkProviders: process.env[FAKE_RUNTIME_ENV] !== 'echo',
    });
    if (options.foreground) {
      // Loaded only here: the daemon brings Nest, TypeORM, and SQLite.
      const { runDaemonProcess } = await import('../../daemon/process.js');
      await runDaemonProcess({ config, foreground: true });
    }

    const layout = ensureWorkspaceLayout(config.workspace);
    const starting = startDetachedDaemon(layout);
    // A Pero this run starts is stopped when its setup does not finish;
    // one that was running already, perhaps as a service, keeps running.
    const guard = interactive
      ? stopOnAbort(async () => {
          const { started, status } = await starting;
          if (!started) return INTERRUPTED_RUNNING;
          await stopDaemon(this.client(), status.pid, layout);
          return INTERRUPTED_STOPPED;
        })
      : null;
    try {
      const { started, status } = await starting;
      const setUp = await this.setUp(status.version, output, prompts);
      if (!interactive || !(firstRun || setUp)) {
        output.block();
        output.print(
          `Pero is ${started ? 'running' : 'already running'} ` +
            `(pid ${status.pid}, workspace ${status.workspace})`,
        );
        return;
      }

      // Where it stands now, so the owner knows setup left it working.
      const service = await localService(layout, execCommand);
      let installed: SystemService | null = null;
      if (service !== null && isServiceInstalled(service)) {
        installed = service;
      } else if (firstRun && service !== null) {
        output.block();
        if (await this.offerService(service, prompts)) {
          // The service owns Pero from here on.
          guard?.release();
          await startAsService(service, layout, execCommand, output.print);
          installed = service;
        }
      }
      guard?.release();
      output.block();
      output.print(
        formatRunning(
          await this.client().status(),
          installed,
          service !== null,
        ),
      );
    } catch (error) {
      // Stopping Pero for a signal fails what was waiting on it; the guard
      // exits once Pero has stopped, saying why.
      if (guard?.ending) await new Promise<never>(() => undefined);
      if (guard === null || !isPromptExit(error)) throw error;
      throw new CliError(await guard.stop(), 130);
    } finally {
      guard?.release();
    }
  }

  /**
   * Finds what is still missing. On a terminal it guides the owner through
   * it; otherwise it prints what to set and returns without reading input.
   * True when it asked the owner anything.
   */
  private async setUp(
    daemonVersion: string,
    output: BlockOutput,
    prompts: () => Promise<Prompts>,
  ): Promise<boolean> {
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
      output.block();
      output.print(
        `The running Pero is version ${daemonVersion}; restart it to set it up (pero stop, then pero run).`,
      );
      return false;
    }

    const chats = await fetchTelegramChats(client);
    const pending = pendingSetup(state.status, state.settings, chats);
    if (pending.length === 0) return false;
    if (!isInteractive()) {
      output.block();
      output.print(formatPendingSetup(pending));
      return false;
    }

    const { runInteractiveSetup } =
      await import('../setup/interactive-setup.js');
    await runInteractiveSetup(
      {
        client,
        prompts: await prompts(),
        print: output.print,
        block: output.block,
      },
      state,
    );
    return true;
  }

  /**
   * Offers to run Pero as `service`, so that it starts with the machine;
   * true when the owner accepts.
   */
  private async offerService(
    service: SystemService,
    prompts: () => Promise<Prompts>,
  ): Promise<boolean> {
    return (await prompts()).confirm({
      message: `Install Pero as a ${service.name}, so it is always running? It then starts with the machine and restarts after a crash.`,
      initial: true,
    });
  }

  @Option({
    flags: '--foreground',
    description: 'run attached to this terminal, logging to stdout',
  })
  parseForeground(): boolean {
    return true;
  }
}
