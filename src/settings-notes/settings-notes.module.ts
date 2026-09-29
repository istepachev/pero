import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module.js';
import { SettingsNotes } from './settings-notes.service.js';

/**
 * The settings notes, rescanned while Pero runs. The rescan runs only
 * where `ScheduleModule.forRoot()` is imported, which is the daemon's
 * AppModule; it needs the global `HostConfigModule`.
 */
@Module({
  imports: [HealthModule],
  providers: [SettingsNotes],
  exports: [SettingsNotes],
})
export class SettingsNotesModule {}
