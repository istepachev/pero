import { Module } from '@nestjs/common';
import { AGENT_RUNTIMES, AgentRuntimes } from './agent-runtimes.js';

/** The Agent runtimes; the Claude and Codex adapters join the list later. */
@Module({
  providers: [{ provide: AGENT_RUNTIMES, useValue: [] }, AgentRuntimes],
  exports: [AgentRuntimes],
})
export class RuntimesModule {}
