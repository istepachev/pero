import { Module } from '@nestjs/common';
import { LogsCommand } from './commands/logs.command.js';
import { PingCommand } from './commands/ping.command.js';
import { RunCommand } from './commands/run.command.js';
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
    PingCommand,
  ],
})
export class CliModule {}
