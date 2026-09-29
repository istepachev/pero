import { Module } from '@nestjs/common';
import {
  AgentsCommand,
  AgentsCreateCommand,
  AgentsDisableCommand,
  AgentsEditCommand,
  AgentsEnableCommand,
  AgentsListCommand,
  AgentsShowCommand,
} from './commands/agents.command.js';
import { BackupCommand } from './commands/backup.command.js';
import {
  ChannelsAssignCommand,
  ChannelsCommand,
  ChannelsDisableCommand,
  ChannelsEnableCommand,
  ChannelsHistoryCommand,
  ChannelsListCommand,
  ChannelsShowCommand,
} from './commands/channels.command.js';
import { CheckCommand } from './commands/check.command.js';
import { InitCommand } from './commands/init.command.js';
import { LogsCommand } from './commands/logs.command.js';
import { PingCommand } from './commands/ping.command.js';
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
  SettingsCommand,
  SettingsSetCommand,
  SettingsShowCommand,
  SettingsUnsetCommand,
} from './commands/settings.command.js';
import { StatusCommand } from './commands/status.command.js';
import { StopCommand } from './commands/stop.command.js';
import {
  TelegramAllowCommand,
  TelegramChatsCommand,
  TelegramCommand,
  TelegramDenyCommand,
} from './commands/telegram.command.js';
import {
  TriggersAddCommand,
  TriggersCommand,
  TriggersDisableCommand,
  TriggersEnableCommand,
  TriggersListCommand,
  TriggersRemoveCommand,
} from './commands/triggers.command.js';
import {
  WorkflowsCommand,
  WorkflowsCreateCommand,
  WorkflowsDisableCommand,
  WorkflowsEditCommand,
  WorkflowsEnableCommand,
  WorkflowsListCommand,
  WorkflowsNotifyCommand,
  WorkflowsRunCommand,
  WorkflowsShowCommand,
} from './commands/workflows.command.js';
import { GlobalOptionsSetup } from './global-options.js';

/**
 * Root module for the `pero` executable. Import only what commands need;
 * never the daemon `AppModule`.
 */
@Module({
  providers: [
    GlobalOptionsSetup,
    InitCommand,
    CheckCommand,
    RunCommand,
    StopCommand,
    StatusCommand,
    LogsCommand,
    SettingsCommand,
    SettingsShowCommand,
    SettingsSetCommand,
    SettingsUnsetCommand,
    AgentsCommand,
    AgentsListCommand,
    AgentsShowCommand,
    AgentsCreateCommand,
    AgentsEditCommand,
    AgentsDisableCommand,
    AgentsEnableCommand,
    ChannelsCommand,
    ChannelsListCommand,
    ChannelsShowCommand,
    ChannelsAssignCommand,
    ChannelsDisableCommand,
    ChannelsEnableCommand,
    ChannelsHistoryCommand,
    WorkflowsCommand,
    WorkflowsListCommand,
    WorkflowsShowCommand,
    WorkflowsCreateCommand,
    WorkflowsEditCommand,
    WorkflowsDisableCommand,
    WorkflowsEnableCommand,
    WorkflowsRunCommand,
    WorkflowsNotifyCommand,
    RunsCommand,
    RunsListCommand,
    RunsShowCommand,
    RunsRetryCommand,
    RunsCancelCommand,
    NotificationsCommand,
    NotificationsListCommand,
    NotificationsShowCommand,
    NotificationsRetryCommand,
    TriggersCommand,
    TriggersListCommand,
    TriggersAddCommand,
    TriggersRemoveCommand,
    TriggersDisableCommand,
    TriggersEnableCommand,
    TelegramCommand,
    TelegramChatsCommand,
    TelegramAllowCommand,
    TelegramDenyCommand,
    BackupCommand,
    RestoreCommand,
    PingCommand,
  ],
})
export class CliModule {}
