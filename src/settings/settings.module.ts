import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module.js';
import { AgentNotes } from './agent-notes.service.js';
import { Definitions } from './definitions.js';
import { SettingsNotes } from './settings-notes.service.js';

/**
 * The settings notes, rescanned while Pero runs, and `Definitions`, which
 * runtime code reads them through. The rescan runs only where
 * `ScheduleModule.forRoot()` is imported, which is the daemon's AppModule;
 * the notes are found through the global `HostConfigModule`, and without
 * it there are none.
 */
@Module({
  imports: [HealthModule],
  providers: [SettingsNotes, AgentNotes, Definitions],
  exports: [SettingsNotes, AgentNotes, Definitions],
})
export class SettingsModule {}
