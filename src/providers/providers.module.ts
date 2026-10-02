import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module.js';
import { SystemModule } from '../system/system.module.js';
import { execCommand } from './provider-auth.js';
import {
  PROVIDER_AUTH_EXEC,
  ProviderAuthService,
} from './provider-auth.service.js';

/** Provider sign-in state; the Agent runtimes join it later. */
@Module({
  imports: [SystemModule, HealthModule],
  providers: [
    { provide: PROVIDER_AUTH_EXEC, useValue: execCommand },
    ProviderAuthService,
  ],
  exports: [ProviderAuthService],
})
export class ProvidersModule {}
