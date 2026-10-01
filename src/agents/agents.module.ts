import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module.js';
import { HistoryModule } from '../history/history.module.js';
import { RuntimesModule } from '../runtimes/runtimes.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { AgentManager } from './agent-manager.js';
import { AgentViews } from './agent-views.service.js';

@Module({
  imports: [
    SettingsModule,
    SessionsModule,
    RuntimesModule,
    HistoryModule,
    HealthModule,
  ],
  providers: [AgentManager, AgentViews],
  exports: [AgentManager, AgentViews],
})
export class AgentsModule {}
