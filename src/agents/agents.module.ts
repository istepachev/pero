import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module.js';
import { HistoryModule } from '../history/history.module.js';
import { RuntimesModule } from '../runtimes/runtimes.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { SystemModule } from '../system/system.module.js';
import { AgentManager } from './agent-manager.js';

@Module({
  imports: [
    SystemModule,
    SessionsModule,
    RuntimesModule,
    HistoryModule,
    HealthModule,
  ],
  providers: [AgentManager],
  exports: [AgentManager],
})
export class AgentsModule {}
