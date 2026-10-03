import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** The `@perokit/pero` package folder; resolves from both src/common and dist/common. */
export const PACKAGE_ROOT = join(import.meta.dirname, '../..');

const { version } = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
) as { version: string };

/** The installed `@perokit/pero` version. */
export const PACKAGE_VERSION = version;
