import { Module } from '@nestjs/common';
import { BackupCommand } from './commands/backup.command.js';
import {
  ChannelsCommand,
  ChannelsHistoryCommand,
  ChannelsListCommand,
  ChannelsShowCommand,
} from './commands/channels.command.js';
import { CheckCommand } from './commands/check.command.js';
import { InitCommand } from './commands/init.command.js';
import { LogsCommand } from './commands/logs.command.js';
import { RestoreCommand } from './commands/restore.command.js';
import { RunCommand } from './commands/run.command.js';
import {
  NotificationsCommand,
  NotificationsListCommand,
  NotificationsRetryCommand,
  NotificationsShowCommand,
} from './commands/notifications.command.js';
import {
  RunsCancelCommand,
  RunsCommand,
  RunsListCommand,
  RunsRetryCommand,
  RunsShowCommand,
} from './commands/runs.command.js';
import {
  ServiceCommand,
  ServiceInstallCommand,
  ServiceUninstallCommand,
} from './commands/service.command.js';
import { SettingsCommand } from './commands/settings.command.js';
import {
  SpeechCommand,
  SpeechConfigureCommand,
  SpeechStatusCommand,
  SpeechVoiceCommand,
} from './commands/speech.command.js';
import { StatusCommand } from './commands/status.command.js';
import { StopCommand } from './commands/stop.command.js';
import {
  TelegramAllowCommand,
  TelegramChatsCommand,
  TelegramCommand,
  TelegramDenyCommand,
  TelegramTokenCommand,
  TelegramTopicCommand,
} from './commands/telegram.command.js';
import { UpgradeCommand } from './commands/upgrade.command.js';
import {
  WorkflowsCommand,
  WorkflowsListCommand,
  WorkflowsRunCommand,
  WorkflowsShowCommand,
} from './commands/workflows.command.js';
import { GlobalOptionsSetup } from './global-options.js';
import { StrictArguments } from './strict-arguments.js';

/**
 * Root module for the `pero` executable. Import only what commands need;
 * never the daemon `AppModule`.
 */
@Module({
  providers: [
    GlobalOptionsSetup,
    StrictArguments,
    InitCommand,
    CheckCommand,
    RunCommand,
    StopCommand,
    StatusCommand,
    ServiceCommand,
    ServiceInstallCommand,
    ServiceUninstallCommand,
    LogsCommand,
    SettingsCommand,
    ChannelsCommand,
    ChannelsListCommand,
    ChannelsShowCommand,
    ChannelsHistoryCommand,
    WorkflowsCommand,
    WorkflowsListCommand,
    WorkflowsShowCommand,
    WorkflowsRunCommand,
    RunsCommand,
    RunsListCommand,
    RunsShowCommand,
    RunsRetryCommand,
    RunsCancelCommand,
    NotificationsCommand,
    NotificationsListCommand,
    NotificationsShowCommand,
    NotificationsRetryCommand,
    TelegramCommand,
    TelegramChatsCommand,
    TelegramAllowCommand,
    TelegramDenyCommand,
    TelegramTokenCommand,
    TelegramTopicCommand,
    SpeechCommand,
    SpeechStatusCommand,
    SpeechConfigureCommand,
    SpeechVoiceCommand,
    BackupCommand,
    RestoreCommand,
    UpgradeCommand,
  ],
})
export class CliModule {}
