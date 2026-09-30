import { Module } from '@nestjs/common';
import { DefinitionsModule } from '../definitions/definitions.module.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { ScheduleTick } from './schedule-tick.js';

/**
 * Polls for schedules that have come due. The tick runs only where
 * `ScheduleModule.forRoot()` is imported, which is the daemon's AppModule.
 */
@Module({
  imports: [DefinitionsModule, WorkflowsModule],
  providers: [ScheduleTick],
  exports: [ScheduleTick],
})
export class SchedulerModule {}
