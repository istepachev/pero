import { Injectable, Logger } from '@nestjs/common';
import { PROVIDERS } from '../config/provider-options.js';
import type { ComponentState, ComponentStatus } from '../control/protocol.js';

/**
 * The state of each part of Pero that can be missing or failing without
 * stopping the daemon. Owners report changes; `pero status` reads them.
 */
@Injectable()
export class ComponentHealth {
  private readonly logger = new Logger('Health');
  private readonly components = new Map<string, ComponentStatus>();

  constructor() {
    // Nothing sets these up yet; their modules report once they exist.
    this.register('telegram', 'Bot token is not set');
    for (const provider of PROVIDERS) {
      this.register(provider, 'Runtime is not set up');
    }
  }

  /** Records `name`'s state; `since` moves only when the state changes. */
  report(name: string, state: ComponentState, detail: string | null = null) {
    const current = this.components.get(name);
    const changed = current?.state !== state;
    this.components.set(name, {
      name,
      state,
      detail,
      since: changed ? new Date().toISOString() : current.since,
    });
    if (changed) {
      const message = `${name} is ${state}${detail ? `: ${detail}` : ''}`;
      if (state === 'degraded') this.logger.warn(message);
      else this.logger.log(message);
    }
  }

  /** Every component, sorted by name. */
  list(): ComponentStatus[] {
    return [...this.components.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /** `ok` only when every component is. */
  overall(): 'ok' | 'degraded' {
    return this.list().every((component) => component.state === 'ok')
      ? 'ok'
      : 'degraded';
  }

  private register(name: string, detail: string): void {
    this.components.set(name, {
      name,
      state: 'unconfigured',
      detail,
      since: new Date().toISOString(),
    });
  }
}
