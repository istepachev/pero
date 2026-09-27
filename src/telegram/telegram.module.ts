import { type DynamicModule, Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module.js';
import {
  TELEGRAM_OPTIONS,
  TelegramCredentials,
  type TelegramOptions,
} from './telegram-credentials.service.js';

/**
 * Telegram configuration; the Channel adapter joins it later. Global, so
 * the control endpoint can change the token without importing it again.
 */
@Module({})
export class TelegramModule {
  static forRoot(options: TelegramOptions): DynamicModule {
    return {
      module: TelegramModule,
      global: true,
      imports: [HealthModule],
      providers: [
        { provide: TELEGRAM_OPTIONS, useValue: options },
        TelegramCredentials,
      ],
      exports: [TelegramCredentials],
    };
  }
}
