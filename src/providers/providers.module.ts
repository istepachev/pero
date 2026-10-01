import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { execCommand } from './provider-auth.js';
import {
  PROVIDER_AUTH_EXEC,
  ProviderAuthService,
} from './provider-auth.service.js';

/** Provider sign-in state; the Agent runtimes join it later. */
@Module({
  imports: [SettingsModule, HealthModule],
  providers: [
    { provide: PROVIDER_AUTH_EXEC, useValue: execCommand },
    ProviderAuthService,
  ],
  exports: [ProviderAuthService],
})
export class ProvidersModule {}
