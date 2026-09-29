import { Injectable } from '@nestjs/common';
import type { Command } from 'commander';
import { InjectCommander } from 'nest-commander';

/** Options every command accepts, before or after the command name. */
export interface GlobalOptions {
  workspace?: string;
  dataDir?: string;
}

/** Adds the global options to the root `pero` program. */
@Injectable()
export class GlobalOptionsSetup {
  constructor(@InjectCommander() program: Command) {
    program
      .name('pero')
      .option(
        '-w, --workspace <dir>',
        'workspace (default: $PERO_WORKSPACE, then the nearest folder with .pero/ from here upward, then ~/workspace)',
      )
      .option(
        '--data-dir <path>',
        'legacy data directory, instead of a workspace (default when no workspace is found: $PERO_HOME, then ~/.pero)',
      );
  }
}
