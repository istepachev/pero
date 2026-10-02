import { Command, CommandRunner, Option, SubCommand } from 'nest-commander';
import {
  DEFAULT_HISTORY_MESSAGES,
  MAX_HISTORY_MESSAGES,
} from '../../control/protocol.js';
import { channelId } from '../channel-id.js';
import { CliError } from '../errors.js';
import {
  formatChannelDetails,
  formatChannelList,
  formatHistory,
} from '../format-channels.js';
import { PeroCommand } from '../pero-command.js';
import { positiveInt } from '../positive-int.js';

const CHANNEL = { channel: "the Channel's ID, as pero channels ls lists it" };

@SubCommand({
  name: 'ls',
  description:
    'List the Channels and the note each is answered with, then the Channel notes none uses',
  options: { isDefault: true },
})
export class ChannelsListCommand extends PeroCommand {
  async run(): Promise<void> {
    const { client } = await this.requireDaemon();
    const { channels, unusedNotes } = await client.call('channels.list');
    console.log(formatChannelList(channels, unusedNotes));
  }
}

@SubCommand({
  name: 'show',
  arguments: '<channel>',
  description:
    'Show a Channel, the settings it is answered with, and whether its next turn resumes its Session',
  argsDescription: CHANNEL,
})
export class ChannelsShowCommand extends PeroCommand {
  async run([channel]: string[]): Promise<void> {
    const id = channelId(channel!);
    const { client } = await this.requireDaemon();
    console.log(
      formatChannelDetails(await client.call('channels.get', { id })),
    );
  }
}

interface HistoryOptions {
  lines?: number;
}

@SubCommand({
  name: 'history',
  arguments: '<channel>',
  description:
    "Print a Channel's latest messages with time, direction, and origin",
  argsDescription: CHANNEL,
})
export class ChannelsHistoryCommand extends PeroCommand {
  async run([channel]: string[], options: HistoryOptions): Promise<void> {
    const id = channelId(channel!);
    const { client } = await this.requireDaemon();
    const result = await client.call('channels.history', {
      id,
      limit: options.lines ?? DEFAULT_HISTORY_MESSAGES,
    });
    console.log(formatHistory(result.channel, result.messages));
  }

  @Option({
    flags: '-n, --lines <count>',
    description: `how many recent messages to show (default: ${DEFAULT_HISTORY_MESSAGES}, at most ${MAX_HISTORY_MESSAGES})`,
  })
  parseLines(value: string): number {
    const count = positiveInt(value);
    if (count === null || count > MAX_HISTORY_MESSAGES) {
      throw new CliError(
        `--lines must be a whole number from 1 to ${MAX_HISTORY_MESSAGES}, not "${value}"`,
      );
    }
    return count;
  }
}

@Command({
  name: 'channels',
  description:
    'List Channels, see the note and settings each is answered with, and read their history',
  subCommands: [
    ChannelsListCommand,
    ChannelsShowCommand,
    ChannelsHistoryCommand,
  ],
})
export class ChannelsCommand extends CommandRunner {
  // `ls` is the default subcommand, so this only runs if that changes.
  async run(): Promise<void> {
    this.command.help();
  }
}
