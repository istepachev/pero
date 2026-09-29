import type { DynamicModule } from '@nestjs/common';
import { join } from 'node:path';
import { HostConfigModule } from '../host-config.module.js';

/** The host config of a legacy data directory `dir`: `dir/config.yaml`. */
export function hostConfigIn(dir: string): DynamicModule {
  return HostConfigModule.forRoot({
    file: join(dir, 'config.yaml'),
    workspace: null,
    base: dir,
  });
}
