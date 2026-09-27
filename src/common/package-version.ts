import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

// Resolves from both src/common and dist/common.
const { version } = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8'),
) as { version: string };

/** The installed `@perokit/pero` version. */
export const PACKAGE_VERSION = version;
