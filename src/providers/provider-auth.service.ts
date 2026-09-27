import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { type Provider, PROVIDERS } from '../config/provider-options.js';
import { ComponentHealth } from '../health/component-health.js';
import { Agent } from '../persistence/entities/agent.entity.js';
import {
  SETTINGS_ID,
  Settings,
} from '../persistence/entities/settings.entity.js';
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
    @InjectDataSource() private readonly dataSource: DataSource,
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
    const settings = await this.dataSource
      .getRepository(Settings)
      .findOneByOrFail({ id: SETTINGS_ID });
    const rows = await this.dataSource
      .getRepository(Agent)
      .createQueryBuilder('agent')
      .select('DISTINCT agent.provider', 'provider')
      .where('agent.enabled = :enabled', { enabled: true })
      .getRawMany<{ provider: Provider }>();
    const used = new Set([
      settings.defaultProvider,
      ...rows.map((row) => row.provider),
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
