import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module.js';
import { SettingsNotes } from './settings-notes.service.js';
import { WorkspaceChecks } from './workspace-checks.service.js';

/**
 * The settings notes, rescanned while Pero runs, and `pero check` for the
 * control endpoint. The rescan runs only
 * where `ScheduleModule.forRoot()` is imported, which is the daemon's
 * AppModule; it needs the global `HostConfigModule`.
 */
@Module({
  imports: [HealthModule],
  providers: [SettingsNotes, WorkspaceChecks],
  exports: [SettingsNotes, WorkspaceChecks],
})
export class SettingsNotesModule {}
