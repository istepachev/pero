import { CommandRunner } from 'nest-commander';
import {
  type BootstrapConfig,
  resolveBootstrapConfig,
} from '../config/bootstrap-config.js';
import {
  type WorkspaceLayout,
  workspaceLayout,
} from '../config/workspace-layout.js';
import {
  type ControlClient,
  type ControlClientOptions,
  createControlClient,
  DaemonNotRunningError,
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
   * Bootstrap configuration from `--workspace`, the environment, or the
   * workspace found from the current folder.
   */
  protected config(): BootstrapConfig {
    const { workspace } = this.command.optsWithGlobals<GlobalOptions>();
    return resolveBootstrapConfig({ workspace });
  }

  /** The workspace's paths; nothing is created. */
  protected layout(): WorkspaceLayout {
    return workspaceLayout(this.config().workspace);
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
   * A client for the running daemon; null when it is stopped, for commands
   * that can do their work without it.
   */
  protected async runningDaemon(): Promise<ControlClient | null> {
    const client = this.client();
    try {
      await client.status();
      return client;
    } catch (error) {
      if (error instanceof DaemonNotRunningError) return null;
      throw error;
    }
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
