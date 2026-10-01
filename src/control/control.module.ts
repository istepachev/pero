import { type DynamicModule, Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { BackupModule } from '../backup/backup.module.js';
import { ChannelsModule } from '../channels/channels.module.js';
import type { WorkspaceLayout } from '../config/workspace-layout.js';
import { HealthModule } from '../health/health.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { WorkspaceChecks } from '../settings/workspace-checks.service.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { CONTROL_LAYOUT, ControlService } from './control.service.js';

export interface ControlOptions {
  layout: WorkspaceLayout;
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
        ProvidersModule,
        AgentsModule,
        ChannelsModule,
        WorkflowsModule,
        NotificationsModule,
        SettingsModule,
        BackupModule.forRoot({ layout: options.layout }),
      ],
      providers: [
        { provide: CONTROL_LAYOUT, useValue: options.layout },
        WorkspaceChecks,
        ControlService,
      ],
      exports: [ControlService],
    };
  }
}
