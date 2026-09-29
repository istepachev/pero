import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { type Provider, PROVIDERS } from '../config/provider-options.js';
import { Definitions } from '../definitions/definitions.js';
import { ComponentHealth } from '../health/component-health.js';
import { checkProviderAuth, type Exec } from './provider-auth.js';

/** How provider CLIs are run; tests replace it. */
export const PROVIDER_AUTH_EXEC = Symbol('PROVIDER_AUTH_EXEC');

/**
 * Keeps each provider's component state current: whether its CLI is signed
 * in, and whether health depends on it at all. A provider is in use when it
 * is the default provider or an enabled Agent uses it.
 */
@Injectable()
export class ProviderAuthService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly abort = new AbortController();
  private running: Promise<void> | undefined;

  constructor(
    private readonly definitions: Definitions,
    private readonly health: ComponentHealth,
    @Inject(PROVIDER_AUTH_EXEC) private readonly exec: Exec,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.refreshRequirements();
    // In the background: readiness must not wait for the provider CLIs.
    void this.check();
  }

  onModuleDestroy(): void {
    this.abort.abort();
  }

  /** The providers health depends on, in `PROVIDERS` order. */
  async inUse(): Promise<Provider[]> {
    const { provider } = await this.definitions.defaults();
    const agents = await this.definitions.agents();
    const used = new Set([
      provider,
      ...agents.filter((agent) => agent.enabled).map((agent) => agent.provider),
    ]);
    return PROVIDERS.filter((provider) => used.has(provider));
  }

  /** Marks the providers in use as required and the others as optional. */
  async refreshRequirements(): Promise<void> {
    const used = new Set(await this.inUse());
    for (const provider of PROVIDERS) {
      this.health.setRequired(provider, used.has(provider));
    }
  }

  /**
   * Checks every provider's sign-in and reports the results. Calls made
   * while a check runs share it.
   */
  check(): Promise<void> {
    this.running ??= this.runCheck().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runCheck(): Promise<void> {
    await this.refreshRequirements();
    await Promise.all(
      PROVIDERS.map(async (provider) => {
        const { state, detail } = await checkProviderAuth(provider, {
          exec: this.exec,
          signal: this.abort.signal,
        });
        if (this.abort.signal.aborted) return;
        this.health.report(provider, state, detail);
      }),
    );
  }
}
