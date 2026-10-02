import { rmSync } from 'node:fs';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import type { BootstrapConfig } from '../config/bootstrap-config.js';
import { ensureWorkspaceLayout } from '../config/workspace-layout.js';
import { ControlService } from '../control/control.service.js';
import { guideFile, writeAgentGuide } from '../guide/agent-guide.js';
import {
  findRunningDaemon,
  removeDaemonMetadata,
  writeDaemonMetadata,
} from '../control/daemon-metadata.js';
import { createLogger } from '../logging/logger.js';
import { PinoLoggerService } from '../logging/pino-logger.service.js';
import { fillWorkspace } from '../system-files/fill-workspace.js';
import { acquireDaemonLock } from './daemon-lock.js';
import { DaemonLifecycle, type StopResult } from './lifecycle.js';

/** How long to ask the other daemon for its pid when it holds the lock. */
const RUNNING_DAEMON_TIMEOUT_MS = 1000;

export interface DaemonOptions {
  config: BootstrapConfig;
  /** Attached to a terminal or supervisor: also log to stdout. */
  foreground: boolean;
  /** The environment settings come from; by default the process's own. */
  env?: NodeJS.ProcessEnv;
}

/** A running daemon. */
export interface Daemon {
  readonly app: INestApplicationContext;
  /**
   * Stops intake, waits for active work up to the shutdown timeout, closes
   * the database, and clears `run/`. Later calls share the first one's result.
   */
  stop(reason: string): Promise<StopResult>;
  /** Settles when the daemon has stopped, whatever stopped it. */
  readonly stopped: Promise<StopResult>;
}

/** Another daemon holds the workspace. */
export class DaemonAlreadyRunningError extends Error {
  override name = 'DaemonAlreadyRunningError';
}

/**
 * Takes the workspace's lock, prepares logging, and starts the daemon.
 * It has no network listener: the CLI reaches it through the control socket,
 * which opens once the database is migrated. Process metadata is written
 * last, once the daemon answers.
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { config } = options;
  const layout = ensureWorkspaceLayout(config.workspace);

  // Before logging, so a refused daemon never writes to the other one's log.
  const lock = acquireDaemonLock(layout.lockFile);
  if (!lock) {
    const running = await findRunningDaemon(layout.metadataFile, {
      timeoutMs: RUNNING_DAEMON_TIMEOUT_MS,
    });
    const pid = running ? ` (pid ${running.metadata.pid})` : '';
    throw new DaemonAlreadyRunningError(
      `Pero is already running for workspace ${layout.workspace}${pid}`,
    );
  }
  const cleanup = () => {
    rmSync(layout.controlSocket, { force: true });
    removeDaemonMetadata(layout.metadataFile);
    lock.release();
  };

  let logger;
  try {
    logger = createLogger({
      level: config.logLevel,
      file: layout.logFile,
      stdout: options.foreground,
    });
  } catch (error) {
    lock.release();
    throw error;
  }

  // What can't be filled in is reported by the startup that needs it.
  try {
    for (const { action, path } of await fillWorkspace(layout.workspace)) {
      logger.info({ path }, `Filled in the workspace: ${action} ${path}`);
    }
  } catch (error) {
    logger.warn({ err: error }, 'Could not fill in the workspace');
  }

  // Agents read it before changing settings; a guide that can't be written
  // leaves them without it, not Pero.
  const guide = guideFile(layout.workspace);
  try {
    if (writeAgentGuide(guide))
      logger.info({ file: guide }, 'Wrote the guide for Agents');
  } catch (error) {
    logger.warn(
      { err: error, file: guide },
      'Could not write the guide for Agents',
    );
  }

  try {
    const app = await NestFactory.createApplicationContext(
      AppModule.forRoot({
        layout,
        ...(options.env ? { env: options.env } : {}),
      }),
      { logger: new PinoLoggerService(logger), abortOnError: false },
    );
    const lifecycle = new DaemonLifecycle({
      close: () => app.close(),
      cleanup,
      logger,
    });
    try {
      const control = app.get(ControlService);
      await control.start({
        onShutdown: () => void lifecycle.stop('shutdown request'),
      });
      const { pid, version, startedAt } = control.status();
      writeDaemonMetadata(layout.metadataFile, {
        pid,
        version,
        workspace: layout.workspace,
        stateDir: layout.stateDir,
        socket: layout.controlSocket,
        startedAt,
      });
    } catch (error) {
      await app.close();
      throw error;
    }
    logger.info(
      {
        workspace: layout.workspace,
        socket: layout.controlSocket,
      },
      'Pero daemon started',
    );
    return {
      app,
      stop: (reason) => lifecycle.stop(reason),
      stopped: lifecycle.stopped,
    };
  } catch (error) {
    cleanup();
    logger.fatal({ err: error }, 'Pero daemon failed to start');
    throw error;
  }
}
