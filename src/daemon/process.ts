import type { BootstrapConfig } from '../config/bootstrap-config.js';
import { ConfigError } from '../config/bootstrap-config.js';
import { DataDirError } from '../config/data-dir.js';
import { ControlSocketError } from '../control/control-server.js';
import { DaemonAlreadyRunningError, startDaemon } from './daemon.js';

const STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export interface DaemonProcessOptions {
  config: BootstrapConfig;
  /** Attached to a terminal or supervisor: also log to stdout. */
  foreground: boolean;
}

/**
 * Runs the daemon as this process until it stops, then exits: 0 after a
 * graceful stop, 1 otherwise. SIGTERM and SIGINT stop it; a second signal
 * exits at once. Startup errors are printed to stderr.
 */
export async function runDaemonProcess(
  options: DaemonProcessOptions,
): Promise<never> {
  let daemon;
  try {
    daemon = await startDaemon(options);
  } catch (error) {
    reportStartupError(error);
    process.exit(1);
  }

  let stopping = false;
  for (const signal of STOP_SIGNALS) {
    process.on(signal, () => {
      // A second signal means stop now; the kernel releases the lock.
      if (stopping) process.exit(1);
      stopping = true;
      void daemon.stop(signal);
    });
  }
  // Logs are written synchronously, so nothing is lost by exiting here.
  const { graceful } = await daemon.stopped;
  process.exit(graceful ? 0 : 1);
}

/** Prints `error`: only the message when the owner can act on it. */
export function reportStartupError(error: unknown): void {
  const expected =
    error instanceof ConfigError ||
    error instanceof DataDirError ||
    error instanceof ControlSocketError ||
    error instanceof DaemonAlreadyRunningError;
  console.error(expected ? error.message : error);
}
