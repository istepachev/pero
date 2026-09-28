import { Module } from '@nestjs/common';
import { RuntimesModule } from '../runtimes/runtimes.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { AgentManager } from './agent-manager.js';
import { AgentsService } from './agents.service.js';

@Module({
  imports: [SessionsModule, RuntimesModule],
  providers: [AgentsService, AgentManager],
  exports: [AgentsService, AgentManager],
})
export class AgentsModule {}
