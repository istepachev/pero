import 'reflect-metadata';
import { parseArgs } from 'node:util';
import {
  ConfigError,
  resolveBootstrapConfig,
} from '../config/bootstrap-config.js';
import { DataDirError } from '../config/data-dir.js';
import { ControlSocketError } from '../control/control-server.js';
import { DaemonAlreadyRunningError, startDaemon } from './daemon.js';

const STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

try {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      foreground: { type: 'boolean', default: false },
    },
  });
  const daemon = await startDaemon({
    config: resolveBootstrapConfig({ dataDir: values['data-dir'] }),
    foreground: values.foreground,
  });

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
} catch (error) {
  const expected =
    error instanceof ConfigError ||
    error instanceof DataDirError ||
    error instanceof ControlSocketError ||
    error instanceof DaemonAlreadyRunningError ||
    (error instanceof TypeError && 'code' in error); // parseArgs usage errors
  console.error(expected ? error.message : error);
  process.exitCode = 1;
}
