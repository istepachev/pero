import 'reflect-metadata';
import { CommandFactory } from 'nest-commander';
import { PACKAGE_VERSION } from '../common/package-version.js';
import { CliModule } from './cli.module.js';

await CommandFactory.run(CliModule, {
  logger: ['error', 'warn'],
  version: PACKAGE_VERSION,
});
