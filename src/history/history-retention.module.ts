import { Module } from '@nestjs/common';
import { DefinitionsModule } from '../definitions/definitions.module.js';
import { HistoryRetention } from './history-retention.js';

/**
 * Deletes message history older than the `history-retention-days`
 * setting. Its hourly pass runs only where `ScheduleModule.forRoot()` is
 * imported, which is the daemon's AppModule.
 */
@Module({
  imports: [DefinitionsModule],
  providers: [HistoryRetention],
  exports: [HistoryRetention],
})
export class HistoryRetentionModule {}
