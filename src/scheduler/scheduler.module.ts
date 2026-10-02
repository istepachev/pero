import { Module } from '@nestjs/common';
import { SystemModule } from '../system/system.module.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { ScheduleTick } from './schedule-tick.js';

/**
 * Polls for schedules that have come due. The tick runs only where
 * `ScheduleModule.forRoot()` is imported, which is the daemon's AppModule.
 */
@Module({
  imports: [SystemModule, WorkflowsModule],
  providers: [ScheduleTick],
  exports: [ScheduleTick],
})
export class SchedulerModule {}
