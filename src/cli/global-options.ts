import { Injectable } from '@nestjs/common';
import type { Command } from 'commander';
import { InjectCommander } from 'nest-commander';
import { PACKAGE_VERSION } from '../common/package-version.js';

/** Options every command accepts, before or after the command name. */
export interface GlobalOptions {
  workspace?: string;
}

/** Adds the global options, and `-v`/`--version`, to the root `pero` program. */
@Injectable()
export class GlobalOptionsSetup {
  constructor(@InjectCommander() program: Command) {
    program
      .name('pero')
      .version(PACKAGE_VERSION, '-v, --version', 'output the version number')
      .option(
        '-w, --workspace <dir>',
        'workspace (default: $PERO_WORKSPACE, then the nearest folder with .pero/ from here upward, then ~/workspace)',
      );
  }
}
