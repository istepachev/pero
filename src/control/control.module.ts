import { type DynamicModule, Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { BackupModule } from '../backup/backup.module.js';
import { ChannelsModule } from '../channels/channels.module.js';
import type { DataDirLayout } from '../config/data-dir.js';
import { HealthModule } from '../health/health.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { TriggersModule } from '../triggers/triggers.module.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { CONTROL_LAYOUT, ControlService } from './control.service.js';

export interface ControlOptions {
  layout: DataDirLayout;
}

/**
 * The owner-only control endpoint the CLI talks to. It also needs the
 * global `TelegramModule`.
 */
@Module({})
export class ControlModule {
  static forRoot(options: ControlOptions): DynamicModule {
    return {
      module: ControlModule,
      imports: [
        HealthModule,
        SettingsModule,
        ProvidersModule,
        AgentsModule,
        ChannelsModule,
        WorkflowsModule,
        NotificationsModule,
        TriggersModule,
        BackupModule.forRoot({ layout: options.layout }),
      ],
      providers: [
        { provide: CONTROL_LAYOUT, useValue: options.layout },
        ControlService,
      ],
      exports: [ControlService],
    };
  }
}
