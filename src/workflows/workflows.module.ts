import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { HistoryModule } from '../history/history.module.js';
import { SystemModule } from '../system/system.module.js';
import { WorkflowExecutor } from './workflow-executor.js';
import { WorkflowRuns } from './workflow-runs.service.js';
import { WorkflowViews } from './workflow-views.service.js';

/** Workflows as the CLI sees them, their runs, and the executor. */
@Module({
  imports: [AgentsModule, SystemModule, HistoryModule],
  providers: [WorkflowViews, WorkflowRuns, WorkflowExecutor],
  exports: [WorkflowViews, WorkflowRuns, WorkflowExecutor],
})
export class WorkflowsModule {}
