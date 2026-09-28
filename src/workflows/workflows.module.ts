import { Module } from '@nestjs/common';
import { WorkflowViews } from './workflow-views.service.js';
import { WorkflowsService } from './workflows.service.js';

/** Workflow definitions; runs and the runner arrive with execution. */
@Module({
  providers: [WorkflowsService, WorkflowViews],
  exports: [WorkflowsService, WorkflowViews],
})
export class WorkflowsModule {}
