import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { resolveBootstrapConfig } from '../config/bootstrap-config.js';
import { reportStartupError, runDaemonProcess } from './process.js';

let options;
try {
  const { values } = parseArgs({
    options: {
      workspace: { type: 'string' },
      foreground: { type: 'boolean', default: false },
    },
  });
  options = {
    config: resolveBootstrapConfig({ workspace: values.workspace }),
    foreground: values.foreground,
  };
} catch (error) {
  // parseArgs usage errors carry a code; print them like other bad input.
  if (error instanceof TypeError && 'code' in error) {
    console.error(error.message);
  } else {
    reportStartupError(error);
  }
  process.exit(1);
}
await runDaemonProcess(options);
