import 'reflect-metadata';
import { CommandFactory } from 'nest-commander';
import { CliModule } from './cli.module.js';
import { reportCliError } from './errors.js';

await CommandFactory.run(CliModule, {
  logger: ['error', 'warn'],
  serviceErrorHandler: reportCliError,
});
