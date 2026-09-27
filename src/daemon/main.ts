import 'reflect-metadata';
import { parseArgs } from 'node:util';
import {
  ConfigError,
  resolveBootstrapConfig,
} from '../config/bootstrap-config.js';
import { DataDirError } from '../config/data-dir.js';
import { ControlSocketError } from '../control/control-server.js';
import { startDaemon } from './daemon.js';

try {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      foreground: { type: 'boolean', default: false },
    },
  });
  await startDaemon({
    config: resolveBootstrapConfig({ dataDir: values['data-dir'] }),
    foreground: values.foreground,
  });
} catch (error) {
  const expected =
    error instanceof ConfigError ||
    error instanceof DataDirError ||
    error instanceof ControlSocketError ||
    (error instanceof TypeError && 'code' in error); // parseArgs usage errors
  console.error(expected ? error.message : error);
  process.exitCode = 1;
}
