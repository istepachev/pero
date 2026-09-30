import { type DynamicModule, Module } from '@nestjs/common';
import type { DataDirLayout } from '../config/data-dir.js';
import { DefinitionsModule } from '../definitions/definitions.module.js';
import { BACKUP_LAYOUT, BackupService } from './backup.service.js';

export interface BackupOptions {
  layout: DataDirLayout;
}

/** Backups of the data directory, written by the running daemon. */
@Module({})
export class BackupModule {
  static forRoot(options: BackupOptions): DynamicModule {
    return {
      module: BackupModule,
      imports: [DefinitionsModule],
      providers: [
        { provide: BACKUP_LAYOUT, useValue: options.layout },
        BackupService,
      ],
      exports: [BackupService],
    };
  }
}
