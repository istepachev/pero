import { type DynamicModule, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AgentsModule } from './agents/agents.module.js';
import { ChannelsModule } from './channels/channels.module.js';
import type { WorkspaceLayout } from './config/workspace-layout.js';
import { resolveDaemonEnv } from './config/daemon-env.js';
import { ControlModule } from './control/control.module.js';
import { HealthModule } from './health/health.module.js';
import { HistoryRetentionModule } from './history/history-retention.module.js';
import { HostConfigModule } from './host-config/host-config.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';
import { ProvidersModule } from './providers/providers.module.js';
import { RuntimeOptionsModule } from './runtimes/runtimes.module.js';
import { SchedulerModule } from './scheduler/scheduler.module.js';
import { SettingsNotesModule } from './settings-notes/settings-notes.module.js';
import { TelegramModule } from './telegram/telegram.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';

export interface AppOptions {
  layout: WorkspaceLayout;
  /**
   * Where settings such as the Telegram bot token may come from; by default
   * the process's own environment.
   */
  env?: NodeJS.ProcessEnv;
}

/** Full daemon module graph. The CLI never imports this module. */
@Module({})
export class AppModule {
  static forRoot(options: AppOptions): DynamicModule {
    const env = options.env ?? process.env;
    // Invalid values fail startup, before anything opens.
    const daemonEnv = resolveDaemonEnv(env);
    return {
      module: AppModule,
      imports: [
        HealthModule,
        RuntimeOptionsModule.forRoot(
          daemonEnv.fakeRuntime ? { fake: daemonEnv.fakeRuntime } : {},
        ),
        PersistenceModule.forRoot({ database: options.layout.database }),
        HostConfigModule.forRoot({
          file: options.layout.configFile,
          workspace: options.layout.workspace,
        }),
        AgentsModule,
        ChannelsModule,
        WorkflowsModule,
        ScheduleModule.forRoot(),
        SchedulerModule,
        SettingsNotesModule,
        NotificationsModule,
        HistoryRetentionModule,
        TelegramModule.forRoot({
          envFile: options.layout.envFile,
          gitignore: options.layout.workspaceGitignore,
          env,
          ...(daemonEnv.telegramApiRoot
            ? { apiRoot: daemonEnv.telegramApiRoot }
            : {}),
        }),
        ProvidersModule,
        ControlModule.forRoot({ layout: options.layout }),
      ],
    };
  }
}
