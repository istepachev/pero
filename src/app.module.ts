import { type DynamicModule, Module } from '@nestjs/common';
import { AgentsModule } from './agents/agents.module.js';
import type { DataDirLayout } from './config/data-dir.js';
import { ControlModule } from './control/control.module.js';
import { HealthModule } from './health/health.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';
import { ProvidersModule } from './providers/providers.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { TelegramModule } from './telegram/telegram.module.js';

export interface AppOptions {
  layout: DataDirLayout;
  /** Where settings such as the Telegram bot token may come from. */
  env?: NodeJS.ProcessEnv;
}

/** Full daemon module graph. The CLI never imports this module. */
@Module({})
export class AppModule {
  static forRoot(options: AppOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        HealthModule,
        PersistenceModule.forRoot({ database: options.layout.database }),
        SettingsModule,
        AgentsModule,
        TelegramModule.forRoot({
          secretsDir: options.layout.secrets,
          env: options.env ?? process.env,
        }),
        ProvidersModule,
        ControlModule.forRoot({ layout: options.layout }),
      ],
    };
  }
}
