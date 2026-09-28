import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { PROVIDERS } from '../config/provider-options.js';
import type { AgentRuntime } from './agent-runtime.js';
import { AGENT_RUNTIMES, AgentRuntimes } from './agent-runtimes.js';
import { ClaudeRuntime } from './claude/claude-runtime.js';
import { FakeAgentRuntime } from './testing/fake-agent-runtime.js';

/** Provided by `RuntimeOptionsModule`; absent means the defaults. */
export const RUNTIME_OPTIONS = Symbol('RUNTIME_OPTIONS');

export interface RuntimeOptions {
  /** For testing only: every provider answers `echo: <message>`. */
  fake?: 'echo';
}

/** The Agent runtimes; the Codex adapter joins the list later. */
@Module({
  providers: [
    {
      provide: AGENT_RUNTIMES,
      useFactory: (options?: RuntimeOptions): AgentRuntime[] => {
        if (options?.fake !== 'echo') return [new ClaudeRuntime()];
        new Logger('Runtimes').warn(
          'PERO_FAKE_RUNTIME=echo: every Agent answers with an echo of its ' +
            'message instead of running a provider. For testing only.',
        );
        return PROVIDERS.map((provider) => new FakeAgentRuntime(provider));
      },
      inject: [{ token: RUNTIME_OPTIONS, optional: true }],
    },
    AgentRuntimes,
  ],
  exports: [AgentRuntimes],
})
export class RuntimesModule {}

/** Daemon-wide runtime options, read wherever `RuntimesModule` is imported. */
@Module({})
export class RuntimeOptionsModule {
  static forRoot(options: RuntimeOptions): DynamicModule {
    return {
      module: RuntimeOptionsModule,
      global: true,
      providers: [{ provide: RUNTIME_OPTIONS, useValue: options }],
      exports: [RUNTIME_OPTIONS],
    };
  }
}
