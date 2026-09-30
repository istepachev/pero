import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { DefinitionsModule } from '../definitions/definitions.module.js';
import { HistoryModule } from '../history/history.module.js';
import { WorkflowExecutor } from './workflow-executor.js';
import { WorkflowRuns } from './workflow-runs.service.js';
import { WorkflowViews } from './workflow-views.service.js';
import { WorkflowsService } from './workflows.service.js';

/** Workflow definitions, their runs, and the executor that runs them. */
@Module({
  imports: [AgentsModule, DefinitionsModule, HistoryModule],
  providers: [WorkflowsService, WorkflowViews, WorkflowRuns, WorkflowExecutor],
  exports: [WorkflowsService, WorkflowViews, WorkflowRuns, WorkflowExecutor],
})
export class WorkflowsModule {}
