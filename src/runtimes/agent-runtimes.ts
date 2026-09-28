import { Inject, Injectable } from '@nestjs/common';
import type { Provider } from '../config/provider-options.js';
import type { AgentRuntime } from './agent-runtime.js';

/** The injection token for the list of available runtimes. */
export const AGENT_RUNTIMES = Symbol('AGENT_RUNTIMES');

/** The runtime for each provider that has one. */
@Injectable()
export class AgentRuntimes {
  private readonly byKind = new Map<Provider, AgentRuntime>();

  constructor(@Inject(AGENT_RUNTIMES) runtimes: AgentRuntime[]) {
    for (const runtime of runtimes) {
      if (this.byKind.has(runtime.kind)) {
        throw new Error(`Two ${runtime.kind} runtimes are registered`);
      }
      this.byKind.set(runtime.kind, runtime);
    }
  }

  /** `provider`'s runtime; null while it has none. */
  get(provider: Provider): AgentRuntime | null {
    return this.byKind.get(provider) ?? null;
  }
}
