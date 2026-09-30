import { Module } from '@nestjs/common';
import { DefinitionsModule } from '../definitions/definitions.module.js';
import { HealthModule } from '../health/health.module.js';
import { HistoryModule } from '../history/history.module.js';
import { RuntimesModule } from '../runtimes/runtimes.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { AgentManager } from './agent-manager.js';
import { AgentViews } from './agent-views.service.js';

@Module({
  imports: [
    DefinitionsModule,
    SessionsModule,
    RuntimesModule,
    HistoryModule,
    HealthModule,
  ],
  providers: [AgentManager, AgentViews],
  exports: [AgentManager, AgentViews],
})
export class AgentsModule {}
