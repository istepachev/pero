import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { type Provider, PROVIDERS } from '../config/provider-options.js';
import { ComponentHealth } from '../health/component-health.js';
import { Definitions } from '../system/definitions.js';
import { checkProviderAuth, type Exec } from './provider-auth.js';

/** How provider CLIs are run; tests replace it. */
export const PROVIDER_AUTH_EXEC = Symbol('PROVIDER_AUTH_EXEC');

/**
 * Keeps each provider's component state current: whether its CLI is signed
 * in, and whether health depends on it at all. A provider is in use when it
 * is the default provider or an enabled Agent uses it, which follows each
 * change to the definitions.
 */
@Injectable()
export class ProviderAuthService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly abort = new AbortController();
  private running: Promise<void> | undefined;
  private stopListening: (() => void) | undefined;

  constructor(
    private readonly definitions: Definitions,
    private readonly health: ComponentHealth,
    @Inject(PROVIDER_AUTH_EXEC) private readonly exec: Exec,
  ) {}

  onApplicationBootstrap(): void {
    this.stopListening = this.definitions.onChange(() =>
      this.refreshRequirements(),
    );
    this.refreshRequirements();
    // In the background: readiness must not wait for the provider CLIs.
    void this.check();
  }

  onModuleDestroy(): void {
    this.stopListening?.();
    this.abort.abort();
  }

  /** The providers health depends on, in `PROVIDERS` order. */
  inUse(): Provider[] {
    const { provider } = this.definitions.defaults();
    const notes = this.definitions.channelNotes();
    const used = new Set([
      provider,
      ...notes.filter((note) => note.enabled).map((note) => note.provider),
    ]);
    return PROVIDERS.filter((provider) => used.has(provider));
  }

  /** Marks the providers in use as required and the others as optional. */
  refreshRequirements(): void {
    const used = new Set(this.inUse());
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
    this.refreshRequirements();
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
