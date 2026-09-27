import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandFactory } from 'nest-commander';
import { CliModule } from './cli.module.js';

// Resolves from both src/cli and dist/cli.
const { version } = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8'),
) as { version: string };

await CommandFactory.run(CliModule, {
  logger: ['error', 'warn'],
  version,
});
