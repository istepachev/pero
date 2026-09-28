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
    // Their modules report the real state once they have looked.
    this.register('telegram', 'Bot token is not set');
    for (const provider of PROVIDERS) {
      this.register(provider, 'Sign-in not checked yet');
    }
  }

  /**
   * Records `name`'s state; `since` moves only when the state changes. A
   * new component is required; an existing one keeps its flag.
   */
  report(name: string, state: ComponentState, detail: string | null = null) {
    const current = this.components.get(name);
    const changed = current?.state !== state;
    this.components.set(name, {
      name,
      state,
      detail,
      since: changed ? new Date().toISOString() : current.since,
      required: current?.required ?? true,
    });
    if (changed) {
      const message = `${name} is ${state}${detail ? `: ${detail}` : ''}`;
      if (state === 'degraded') this.logger.warn(message);
      else this.logger.log(message);
    }
  }

  /** `name`'s current status; undefined when it is not registered. */
  get(name: string): ComponentStatus | undefined {
    return this.components.get(name);
  }

  /** Every component, sorted by name. */
  list(): ComponentStatus[] {
    return [...this.components.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /** Whether overall health depends on `name`, which must be registered. */
  setRequired(name: string, required: boolean): void {
    const current = this.components.get(name);
    if (current) this.components.set(name, { ...current, required });
  }

  /** `ok` only when every required component is. */
  overall(): 'ok' | 'degraded' {
    return this.list().every(
      (component) => !component.required || component.state === 'ok',
    )
      ? 'ok'
      : 'degraded';
  }

  private register(name: string, detail: string): void {
    this.components.set(name, {
      name,
      state: 'unconfigured',
      detail,
      since: new Date().toISOString(),
      required: true,
    });
  }
}
