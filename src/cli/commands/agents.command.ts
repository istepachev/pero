import { Command, CommandRunner, SubCommand } from 'nest-commander';
import { formatAgentDetails, formatAgentList } from '../format-agents.js';
import { PeroCommand } from '../pero-command.js';

const NAME = { name: "the Agent's name, as pero agents ls lists it" };

@SubCommand({
  name: 'ls',
  description: 'List the Agents',
  options: { isDefault: true },
})
export class AgentsListCommand extends PeroCommand {
  async run(): Promise<void> {
    const { client } = await this.requireDaemon();
    const { agents } = await client.call('agents.list');
    console.log(formatAgentList(agents));
  }
}

@SubCommand({
  name: 'show',
  arguments: '<name>',
  description:
    "Show an Agent, its Channels, and whether each Channel's next turn resumes its Session",
  argsDescription: NAME,
})
export class AgentsShowCommand extends PeroCommand {
  async run([name]: string[]): Promise<void> {
    const { client } = await this.requireDaemon();
    console.log(
      formatAgentDetails(await client.call('agents.get', { name: name! })),
    );
  }
}

@Command({
  name: 'agents',
  description: 'List and show the Agents, which notes define',
  subCommands: [AgentsListCommand, AgentsShowCommand],
})
export class AgentsCommand extends CommandRunner {
  // `ls` is the default subcommand, so this only runs if that changes.
  async run(): Promise<void> {
    this.command.help();
  }
}
