import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { AgentsService } from '../agents/agents.service.js';
import { ComponentHealth } from '../health/component-health.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsService } from '../settings/settings.service.js';
import type { Exec } from './provider-auth.js';
import {
  PROVIDER_AUTH_EXEC,
  ProviderAuthService,
} from './provider-auth.service.js';
import { ProvidersModule } from './providers.module.js';

describe('ProviderAuthService', () => {
  let tmp: string;
  let moduleRef: TestingModule;
  let service: ProviderAuthService;
  let health: ComponentHealth;
  let agents: AgentsService;
  let settings: SettingsService;
  let signedIn: Set<string>;
  let calls: number;

  const exec: Exec = (command) => {
    calls += 1;
    return Promise.resolve(
      command === 'claude'
        ? {
            code: signedIn.has('claude') ? 0 : 1,
            stdout: JSON.stringify({ loggedIn: signedIn.has('claude') }),
          }
        : { code: signedIn.has('codex') ? 0 : 1, stdout: 'Logged in\n' },
    );
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-providers-'));
    const vault = join(tmp, 'vault');
    mkdirSync(vault);
    signedIn = new Set();
    calls = 0;
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: join(tmp, 'pero.sqlite') }),
        SettingsModule,
        AgentsModule,
        ProvidersModule,
      ],
    })
      .overrideProvider(PROVIDER_AUTH_EXEC)
      .useValue(exec)
      .compile();
    service = moduleRef.get(ProviderAuthService);
    health = moduleRef.get(ComponentHealth);
    agents = moduleRef.get(AgentsService);
    settings = moduleRef.get(SettingsService);
    await settings.update({ defaultWorkingDirectory: vault });
  });

  afterEach(async () => {
    await moduleRef.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const component = (name: string) =>
    health.list().find((c) => c.name === name);

  it('requires only the default provider while no Agent exists', async () => {
    await service.check();

    expect(component('claude')).toMatchObject({
      state: 'unconfigured',
      required: true,
    });
    expect(component('codex')).toMatchObject({
      state: 'unconfigured',
      required: false,
    });
    expect(await service.inUse()).toEqual(['claude']);
  });

  it('follows the default provider and enabled Agents', async () => {
    await settings.update({ defaultProvider: 'codex' });
    expect(await service.inUse()).toEqual(['codex']);

    await agents.create({ name: 'assistant', provider: 'claude' });
    expect(await service.inUse()).toEqual(['claude', 'codex']);

    await agents.edit('assistant', { enabled: false });
    await service.refreshRequirements();
    expect(await service.inUse()).toEqual(['codex']);
    expect(component('claude')?.required).toBe(false);
  });

  it('reports a sign-in once checked again', async () => {
    await service.check();
    signedIn.add('claude');

    await service.check();

    expect(component('claude')).toMatchObject({ state: 'ok' });
    expect(health.overall()).toBe('degraded'); // Telegram is still missing.
    health.report('telegram', 'ok');
    expect(health.overall()).toBe('ok');
  });

  it('shares a check that is already running', async () => {
    await Promise.all([service.check(), service.check()]);

    expect(calls).toBe(2);
  });
});
