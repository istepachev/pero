import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { ComponentHealth } from '../health/component-health.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { TestWorkspace } from '../system/testing/test-workspace.js';
import type { Exec } from './provider-auth.js';
import {
  PROVIDER_AUTH_EXEC,
  ProviderAuthService,
} from './provider-auth.service.js';
import { ProvidersModule } from './providers.module.js';

describe('ProviderAuthService', () => {
  let ws: TestWorkspace;
  let moduleRef: TestingModule;
  let service: ProviderAuthService;
  let health: ComponentHealth;
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
    ws = TestWorkspace.create('pero-providers-');
    signedIn = new Set();
    calls = 0;
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: ws.database }),
        ws.hostConfig(),
        AgentsModule,
        ProvidersModule,
      ],
    })
      .overrideProvider(PROVIDER_AUTH_EXEC)
      .useValue(exec)
      .compile();
    service = moduleRef.get(ProviderAuthService);
    health = moduleRef.get(ComponentHealth);
    ws.use(moduleRef);
  });

  afterEach(async () => {
    await moduleRef.close();
    ws.delete();
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
    expect(service.inUse()).toEqual(['claude']);
  });

  it('follows the default provider and enabled Agents', async () => {
    await moduleRef.init();
    await ws.pero({ provider: 'codex' });
    expect(service.inUse()).toEqual(['codex']);

    await ws.agent('Assistant', { provider: 'claude' });
    expect(service.inUse()).toEqual(['claude', 'codex']);

    await ws.editAgent('Assistant', { enabled: false });
    service.refreshRequirements();
    expect(service.inUse()).toEqual(['codex']);
    expect(component('claude')?.required).toBe(false);
  });

  it('follows each change to the definitions once running', async () => {
    await moduleRef.init();
    expect(component('codex')?.required).toBe(false);

    await ws.agent('Coder', { provider: 'codex' });
    await vi.waitFor(() => expect(component('codex')?.required).toBe(true));

    await ws.editAgent('Coder', { enabled: false });
    await vi.waitFor(() => expect(component('codex')?.required).toBe(false));
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
