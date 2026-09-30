import { type DynamicModule, Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import {
  HOST_CONFIG_OPTIONS,
  HostConfigService,
  type HostConfigOptions,
} from './host-config.service.js';

/**
 * `config.yaml`, the host settings. Global, so the chat allowlist and the
 * control endpoint reach it without importing it again.
 */
@Module({})
export class HostConfigModule {
  static forRoot(options: HostConfigOptions): DynamicModule {
    return {
      module: HostConfigModule,
      global: true,
      imports: [HealthModule, SettingsModule],
      providers: [
        { provide: HOST_CONFIG_OPTIONS, useValue: options },
        HostConfigService,
      ],
      exports: [HostConfigService],
    };
  }
}
