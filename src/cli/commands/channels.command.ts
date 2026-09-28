import { Command, CommandRunner, Option, SubCommand } from 'nest-commander';
import {
  DEFAULT_HISTORY_MESSAGES,
  MAX_HISTORY_MESSAGES,
} from '../../control/protocol.js';
import { CliError } from '../errors.js';
import {
  agentWarning,
  describeChannel,
  formatAssigned,
  formatChannelDetails,
  formatChannelList,
  formatHistory,
} from '../format-channels.js';
import { PeroCommand } from '../pero-command.js';
import { positiveInt } from '../positive-int.js';

const CHANNEL = { channel: "the Channel's ID, as pero channels ls lists it" };

@SubCommand({
  name: 'ls',
  description: 'List the Channels and the Agent each is assigned',
  options: { isDefault: true },
})
export class ChannelsListCommand extends PeroCommand {
  async run(): Promise<void> {
    const { client } = await this.requireDaemon();
    const { channels } = await client.call('channels.list');
    console.log(formatChannelList(channels));
  }
}

@SubCommand({
  name: 'show',
  arguments: '<channel>',
  description:
    'Show a Channel, its Agent, and whether its next turn resumes its Session',
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

@SubCommand({
  name: 'assign',
  arguments: '<channel> <agent>',
  description:
    'Point a Channel at another Agent; its next turn starts a fresh Session that carries over recent messages',
  argsDescription: {
    ...CHANNEL,
    agent: "the Agent's name, as pero agents ls lists it",
  },
})
export class ChannelsAssignCommand extends PeroCommand {
  async run([channel, agent]: string[]): Promise<void> {
    const id = channelId(channel!);
    const { client } = await this.requireDaemon();
    const result = await client.call('channels.assign', { id, agent: agent! });
    console.log(formatAssigned(result.channel, result.alreadyAssigned));
  }
}

@SubCommand({
  name: 'disable',
  arguments: '<channel>',
  description:
    'Ignore messages in a Channel; its Agent and Sessions are kept, and it is not onboarded again',
  argsDescription: CHANNEL,
})
export class ChannelsDisableCommand extends PeroCommand {
  async run([channel]: string[]): Promise<void> {
    const id = channelId(channel!);
    const { client } = await this.requireDaemon();
    const details = await client.call('channels.setEnabled', {
      id,
      enabled: false,
    });
    console.log(
      `Disabled ${describeChannel(details)}. Its messages are ignored until pero channels enable ${id}.`,
    );
  }
}

@SubCommand({
  name: 'enable',
  arguments: '<channel>',
  description: 'Let a disabled Channel reach its Agent again',
  argsDescription: CHANNEL,
})
export class ChannelsEnableCommand extends PeroCommand {
  async run([channel]: string[]): Promise<void> {
    const id = channelId(channel!);
    const { client } = await this.requireDaemon();
    const details = await client.call('channels.setEnabled', {
      id,
      enabled: true,
    });
    console.log(
      `Enabled ${describeChannel(details)}: it talks to Agent ${details.agent}.`,
    );
    const warning = agentWarning(details);
    if (warning !== null) console.error(warning);
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
    'List Channels, point them at other Agents, disable them, and read their history',
  subCommands: [
    ChannelsListCommand,
    ChannelsShowCommand,
    ChannelsAssignCommand,
    ChannelsDisableCommand,
    ChannelsEnableCommand,
    ChannelsHistoryCommand,
  ],
})
export class ChannelsCommand extends CommandRunner {
  // `ls` is the default subcommand, so this only runs if that changes.
  async run(): Promise<void> {
    this.command.help();
  }
}

/** The Channel ID the owner typed; a `CliError` when it is not one. */
function channelId(value: string): number {
  const id = positiveInt(value);
  if (id === null) {
    throw new CliError(
      `channel must be a Channel ID, as pero channels ls lists it, not "${value}"`,
    );
  }
  return id;
}
