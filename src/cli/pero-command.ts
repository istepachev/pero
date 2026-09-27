import { CommandRunner } from 'nest-commander';
import {
  type BootstrapConfig,
  resolveBootstrapConfig,
} from '../config/bootstrap-config.js';
import { dataDirLayout, type DataDirLayout } from '../config/data-dir.js';
import {
  type ControlClient,
  type ControlClientOptions,
  createControlClient,
} from '../control/client.js';
import type { StatusResult } from '../control/protocol.js';
import type { GlobalOptions } from './global-options.js';

/** A running daemon, reached through its control socket. */
export interface DaemonConnection {
  client: ControlClient;
  status: StatusResult;
}

/** Base for `pero` commands: resolves the data directory and the daemon. */
export abstract class PeroCommand extends CommandRunner {
  /** Bootstrap configuration from `--data-dir`, the environment, or defaults. */
  protected config(): BootstrapConfig {
    const { dataDir } = this.command.optsWithGlobals<GlobalOptions>();
    return resolveBootstrapConfig({ dataDir });
  }

  /** The data directory's paths; nothing is created. */
  protected layout(): DataDirLayout {
    return dataDirLayout(this.config().dataDir);
  }

  protected client(options?: ControlClientOptions): ControlClient {
    return createControlClient(this.layout().controlSocket, options);
  }

  /**
   * The guard for commands that need the daemon. It never starts one: when
   * the daemon is stopped, this throws `DaemonNotRunningError`, which exits
   * with "Pero isn't running — start it with pero run".
   */
  protected async requireDaemon(): Promise<DaemonConnection> {
    const client = this.client();
    return { client, status: await client.status() };
  }
}
