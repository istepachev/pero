import { type DynamicModule, Module } from '@nestjs/common';
import { AgentsModule } from './agents/agents.module.js';
import type { DataDirLayout } from './config/data-dir.js';
import { HealthModule } from './health/health.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';
import { SettingsModule } from './settings/settings.module.js';

export interface AppOptions {
  layout: DataDirLayout;
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
      ],
    };
  }
}
