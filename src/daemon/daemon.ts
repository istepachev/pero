import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import type { BootstrapConfig } from '../config/bootstrap-config.js';
import { ensureDataDir } from '../config/data-dir.js';
import { ControlService } from '../control/control.service.js';
import { createLogger } from '../logging/logger.js';
import { PinoLoggerService } from '../logging/pino-logger.service.js';

export interface DaemonOptions {
  config: BootstrapConfig;
  /** Attached to a terminal or supervisor: also log to stdout. */
  foreground: boolean;
}

/**
 * Prepares the data directory and logging, then starts the daemon. It has
 * no network listener: the CLI reaches it through the control socket, which
 * opens last, once the database is migrated.
 */
export async function startDaemon(
  options: DaemonOptions,
): Promise<INestApplicationContext> {
  const { config } = options;
  const layout = ensureDataDir(config.dataDir);
  const logger = createLogger({
    level: config.logLevel,
    file: layout.logFile,
    stdout: options.foreground,
  });

  try {
    const app = await NestFactory.createApplicationContext(
      AppModule.forRoot({ layout }),
      { logger: new PinoLoggerService(logger), abortOnError: false },
    );
    app.enableShutdownHooks();
    try {
      await app.get(ControlService).start({
        onShutdown: () => {
          logger.info('Shutdown requested');
          app.close().catch((error: unknown) => {
            logger.error({ err: error }, 'Pero daemon failed to shut down');
          });
        },
      });
    } catch (error) {
      await app.close();
      throw error;
    }
    logger.info(
      { dataDir: layout.root, socket: layout.controlSocket },
      'Pero daemon started',
    );
    return app;
  } catch (error) {
    logger.fatal({ err: error }, 'Pero daemon failed to start');
    throw error;
  }
}
