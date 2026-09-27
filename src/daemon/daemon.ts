import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../app.module.js';
import type { BootstrapConfig } from '../config/bootstrap-config.js';
import { ensureDataDir } from '../config/data-dir.js';
import { createLogger } from '../logging/logger.js';
import { PinoLoggerService } from '../logging/pino-logger.service.js';

// Loopback only: the HTTP surface is private until administration is authenticated.
const HOST = '127.0.0.1';

export interface DaemonOptions {
  config: BootstrapConfig;
  /** Attached to a terminal or supervisor: also log to stdout. */
  foreground: boolean;
}

/** Prepares the data directory and logging, then starts the daemon. */
export async function startDaemon(
  options: DaemonOptions,
): Promise<NestFastifyApplication> {
  const { config } = options;
  const layout = ensureDataDir(config.dataDir);
  const logger = createLogger({
    level: config.logLevel,
    file: layout.logFile,
    stdout: options.foreground,
  });

  try {
    const app = await NestFactory.create<NestFastifyApplication>(
      AppModule.forRoot({ layout }),
      new FastifyAdapter(),
      { logger: new PinoLoggerService(logger), abortOnError: false },
    );
    app.enableShutdownHooks();
    try {
      await app.listen(config.port, HOST);
    } catch (error) {
      await app.close();
      throw error;
    }
    logger.info(
      { dataDir: layout.root, url: await app.getUrl() },
      'Pero daemon started',
    );
    return app;
  } catch (error) {
    logger.fatal({ err: error }, 'Pero daemon failed to start');
    throw error;
  }
}
