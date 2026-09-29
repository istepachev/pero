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
import { readDaemonMetadata } from '../control/daemon-metadata.js';
import type { StatusResult } from '../control/protocol.js';
import type { GlobalOptions } from './global-options.js';

/** A running daemon, reached through its control socket. */
export interface DaemonConnection {
  client: ControlClient;
  status: StatusResult;
}

/** Base for `pero` commands: resolves the workspace and the daemon. */
export abstract class PeroCommand extends CommandRunner {
  /**
   * Bootstrap configuration from `--workspace` or `--data-dir`, the
   * environment, or the workspace found from the current folder.
   */
  protected config(): BootstrapConfig {
    const { workspace, dataDir } =
      this.command.optsWithGlobals<GlobalOptions>();
    return resolveBootstrapConfig({ workspace, dataDir });
  }

  /** The state directory's paths; nothing is created. */
  protected layout(): DataDirLayout {
    const { dataDir, workspace } = this.config();
    return dataDirLayout(dataDir, workspace);
  }

  /**
   * A client for the daemon's control socket: where the running daemon
   * recorded it, or else where it would be.
   */
  protected client(options?: ControlClientOptions): ControlClient {
    const layout = this.layout();
    const socket =
      readDaemonMetadata(layout.metadataFile)?.socket ?? layout.controlSocket;
    return createControlClient(socket, options);
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
