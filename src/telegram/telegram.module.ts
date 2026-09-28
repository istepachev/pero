import { type DynamicModule, Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module.js';
import { HealthModule } from '../health/health.module.js';
import { TelegramAdapter } from './telegram-adapter.js';
import { TelegramChats } from './telegram-chats.service.js';
import {
  TELEGRAM_OPTIONS,
  TelegramCredentials,
  type TelegramOptions,
} from './telegram-credentials.service.js';
import { TelegramStatus } from './telegram-status.js';

/**
 * Telegram: the bot token, the Channel adapter, which connects to the
 * Channel router at startup, and the allowlist commands. Global, so the
 * control endpoint can reach them without importing it again.
 */
@Module({})
export class TelegramModule {
  static forRoot(options: TelegramOptions): DynamicModule {
    return {
      module: TelegramModule,
      global: true,
      imports: [HealthModule, ChannelsModule],
      providers: [
        { provide: TELEGRAM_OPTIONS, useValue: options },
        TelegramCredentials,
        TelegramStatus,
        TelegramAdapter,
        TelegramChats,
      ],
      exports: [
        TelegramCredentials,
        TelegramStatus,
        TelegramAdapter,
        TelegramChats,
      ],
    };
  }
}
