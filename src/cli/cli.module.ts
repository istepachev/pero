import { Module } from '@nestjs/common';
import { BackupCommand } from './commands/backup.command.js';
import { LogsCommand } from './commands/logs.command.js';
import { PingCommand } from './commands/ping.command.js';
import { RestoreCommand } from './commands/restore.command.js';
import { RunCommand } from './commands/run.command.js';
import {
  SettingsCommand,
  SettingsSetCommand,
  SettingsShowCommand,
  SettingsUnsetCommand,
} from './commands/settings.command.js';
import { StatusCommand } from './commands/status.command.js';
import { StopCommand } from './commands/stop.command.js';
import { GlobalOptionsSetup } from './global-options.js';

/**
 * Root module for the `pero` executable. Import only what commands need;
 * never the daemon `AppModule`.
 */
@Module({
  providers: [
    GlobalOptionsSetup,
    RunCommand,
    StopCommand,
    StatusCommand,
    LogsCommand,
    SettingsCommand,
    SettingsShowCommand,
    SettingsSetCommand,
    SettingsUnsetCommand,
    BackupCommand,
    RestoreCommand,
    PingCommand,
  ],
})
export class CliModule {}
