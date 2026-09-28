import { Module } from '@nestjs/common';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { TriggersService } from './triggers.service.js';

/** The Triggers that start Workflows: schedules and manual starts. */
@Module({
  imports: [WorkflowsModule],
  providers: [TriggersService],
  exports: [TriggersService],
})
export class TriggersModule {}
