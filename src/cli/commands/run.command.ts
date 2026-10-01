import { Command, Option } from 'nest-commander';
import { FAKE_RUNTIME_ENV } from '../../config/daemon-env.js';
import {
  ensureWorkspaceLayout,
  type WorkspaceLayout,
} from '../../config/workspace-layout.js';
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
import { configOrNewWorkspace } from '../setup/first-run.js';
import {
  fetchTelegramChats,
  formatPendingSetup,
  pendingSetup,
} from '../setup/pending-setup.js';
import { startDetachedDaemon } from '../start-daemon.js';
import { isServiceInstalled, type SystemService } from '../system-service.js';

/** Provider CLIs may take a while to report their sign-in. */
const SETUP_TIMEOUT_MS = 60_000;

const INTERRUPTED =
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
    const { config, firstRun } = await configOrNewWorkspace({
      config: () => this.config(),
      interactive,
      prompts: terminalPrompts,
      print: (text) => console.log(text),
      checkProviders: process.env[FAKE_RUNTIME_ENV] !== 'echo',
    });
    if (options.foreground) {
      // Loaded only here: the daemon brings Nest, TypeORM, and SQLite.
      const { runDaemonProcess } = await import('../../daemon/process.js');
      await runDaemonProcess({ config, foreground: true });
    }

    const layout = ensureWorkspaceLayout(config.workspace);
    const { started, status } = await startDetachedDaemon(layout);
    console.log(
      `Pero is ${started ? 'running' : 'already running'} ` +
        `(pid ${status.pid}, workspace ${status.workspace})`,
    );
    const setUp = await this.setUp(status.version);
    if (!interactive || !(firstRun || setUp)) return;

    // Where it stands now, so the owner knows setup left it working.
    const service = await localService(layout, execCommand);
    const installed =
      service !== null && isServiceInstalled(service)
        ? service
        : firstRun && service !== null
          ? await this.offerService(service, layout)
          : null;
    console.log(
      `\n${formatRunning(await this.client().status(), installed, service !== null)}`,
    );
  }

  /**
   * Finds what is still missing. On a terminal it guides the owner through
   * it; otherwise it prints what to set and returns without reading input.
   * True when it asked the owner anything.
   */
  private async setUp(daemonVersion: string): Promise<boolean> {
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
      return false;
    }

    const chats = await fetchTelegramChats(client);
    const pending = pendingSetup(state.status, state.settings, chats);
    if (pending.length === 0) return false;
    if (!isInteractive()) {
      console.log(formatPendingSetup(pending));
      return false;
    }

    const { runInteractiveSetup } =
      await import('../setup/interactive-setup.js');
    await interruptible(async () =>
      runInteractiveSetup(
        {
          client,
          prompts: await terminalPrompts(),
          print: (text) => console.log(text),
        },
        state,
      ),
    );
    return true;
  }

  /**
   * Offers to run Pero as `service`, so that it starts with the machine;
   * the service when it was installed, null when declined.
   */
  private async offerService(
    service: SystemService,
    layout: WorkspaceLayout,
  ): Promise<SystemService | null> {
    const prompts: Prompts = await terminalPrompts();
    const install = await interruptible(() =>
      prompts.confirm({
        message: `Install Pero as a ${service.name}, so it is always running? It then starts with the machine and restarts after a crash.`,
        initial: true,
      }),
    );
    if (!install) return null;
    await startAsService(service, layout, execCommand, (text) =>
      console.log(text),
    );
    return service;
  }

  @Option({
    flags: '--foreground',
    description: 'run attached to this terminal, logging to stdout',
  })
  parseForeground(): boolean {
    return true;
  }
}

/** `ask`, with Ctrl-C or Ctrl-D turned into the exit setup makes then. */
async function interruptible<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (error) {
    if (!isPromptExit(error)) throw error;
    throw new CliError(INTERRUPTED, 130);
  }
}
