import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module.js';
import { HistoryModule } from '../history/history.module.js';
import { RuntimesModule } from '../runtimes/runtimes.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { AgentManager } from './agent-manager.js';
import { AgentsService } from './agents.service.js';

@Module({
  imports: [SessionsModule, RuntimesModule, HistoryModule, HealthModule],
  providers: [AgentsService, AgentManager],
  exports: [AgentsService, AgentManager],
})
export class AgentsModule {}
