import { type DynamicModule, Module } from '@nestjs/common';
import type { WorkspaceLayout } from '../config/workspace-layout.js';
import { SettingsModule } from '../settings/settings.module.js';
import { BACKUP_LAYOUT, BackupService } from './backup.service.js';

export interface BackupOptions {
  layout: WorkspaceLayout;
}

/** Backups of the workspace, written by the running daemon. */
@Module({})
export class BackupModule {
  static forRoot(options: BackupOptions): DynamicModule {
    return {
      module: BackupModule,
      imports: [SettingsModule],
      providers: [
        { provide: BACKUP_LAYOUT, useValue: options.layout },
        BackupService,
      ],
      exports: [BackupService],
    };
  }
}
