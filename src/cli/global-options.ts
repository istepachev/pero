import { Injectable } from '@nestjs/common';
import type { Command } from 'commander';
import { InjectCommander } from 'nest-commander';

/** Options every command accepts, before or after the command name. */
export interface GlobalOptions {
  dataDir?: string;
}

/** Adds the global options to the root `pero` program. */
@Injectable()
export class GlobalOptionsSetup {
  constructor(@InjectCommander() program: Command) {
    program
      .name('pero')
      .option(
        '--data-dir <path>',
        'data directory (default: $PERO_HOME, then ~/.pero)',
      );
  }
}
