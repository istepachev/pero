import type { Logger } from 'pino';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from '../persistence/entities/settings.entity.js';

/**
 * Time allowed past the shutdown timeout for closing the control socket and
 * the database once active work has finished or been abandoned.
 */
export const CLOSE_MARGIN_MS = 5000;

export interface StopResult {
  /** False when closing failed or outlasted its deadline. */
  graceful: boolean;
}

export interface DaemonLifecycleOptions {
  /**
   * Runs the application's shutdown hooks in order: intake stops, active
   * work drains, the database closes.
   */
  close: () => Promise<void>;
  /** How long to wait for active work; read when stopping begins. */
  shutdownTimeoutMs: () => Promise<number>;
  /** Clears `run/` and releases the lock; runs even when closing failed. */
  cleanup: () => void;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  closeMarginMs?: number;
}

/** Stops the daemon once, however many times and ways it is asked to. */
export class DaemonLifecycle {
  /** Settles when the daemon has stopped, whatever stopped it. */
  readonly stopped: Promise<StopResult>;
  private resolveStopped!: (result: StopResult) => void;
  private stopping: Promise<StopResult> | undefined;

  constructor(private readonly options: DaemonLifecycleOptions) {
    this.stopped = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  /** Stops the daemon; later calls share the first one's result. */
  stop(reason: string): Promise<StopResult> {
    this.stopping ??= this.run(reason);
    return this.stopping;
  }

  private async run(reason: string): Promise<StopResult> {
    const { logger } = this.options;
    logger.info({ reason }, 'Pero daemon stopping');

    const deadlineMs =
      (await this.shutdownTimeoutMs()) +
      (this.options.closeMarginMs ?? CLOSE_MARGIN_MS);
    let graceful: boolean;
    try {
      graceful = await withDeadline(this.options.close(), deadlineMs);
      if (!graceful) {
        logger.error(
          { deadlineMs },
          `Pero daemon did not stop within ${deadlineMs} ms; exiting anyway`,
        );
      }
    } catch (error) {
      logger.error({ err: error }, 'Pero daemon failed to shut down cleanly');
      graceful = false;
    }

    try {
      this.options.cleanup();
    } catch (error) {
      logger.error({ err: error }, 'Pero daemon failed to clean up run/');
      graceful = false;
    }

    if (graceful) logger.info('Pero daemon stopped');
    const result = { graceful };
    this.resolveStopped(result);
    return result;
  }

  private async shutdownTimeoutMs(): Promise<number> {
    try {
      return await this.options.shutdownTimeoutMs();
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        `Cannot read the shutdown timeout; using ${DEFAULT_SHUTDOWN_TIMEOUT_MS} ms`,
      );
      return DEFAULT_SHUTDOWN_TIMEOUT_MS;
    }
  }
}

/** Whether `work` settled within `ms`; rejects if it failed in time. */
async function withDeadline(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true as const), expired]);
  } finally {
    clearTimeout(timer);
  }
}
