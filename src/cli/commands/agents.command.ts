import { Command, CommandRunner, SubCommand } from 'nest-commander';
import type { AgentAction } from '../../settings-files/note-hints.js';
import { formatAgentDetails, formatAgentList } from '../format-agents.js';
import { agentStub } from '../note-stubs.js';
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

/** A removed command that says which note to edit instead. */
abstract class AgentStubCommand extends PeroCommand {
  protected abstract readonly action: AgentAction;

  async run([name]: string[]): Promise<void> {
    await agentStub(this.config(), this.action, name!);
  }
}

@SubCommand({
  name: 'create',
  arguments: '<name>',
  description: 'Removed: add an Agent note instead; this says where',
  argsDescription: NAME,
  allowUnknownOptions: true,
})
export class AgentsCreateCommand extends AgentStubCommand {
  protected readonly action = 'create';
}

@SubCommand({
  name: 'edit',
  arguments: '<name>',
  description: "Removed: edit the Agent's note instead; this says where",
  argsDescription: NAME,
  allowUnknownOptions: true,
})
export class AgentsEditCommand extends AgentStubCommand {
  protected readonly action = 'edit';
}

@SubCommand({
  name: 'disable',
  arguments: '<name>',
  description: "Removed: set enabled: false in the Agent's note instead",
  argsDescription: NAME,
})
export class AgentsDisableCommand extends AgentStubCommand {
  protected readonly action = 'disable';
}

@SubCommand({
  name: 'enable',
  arguments: '<name>',
  description: "Removed: set enabled: true in the Agent's note instead",
  argsDescription: NAME,
})
export class AgentsEnableCommand extends AgentStubCommand {
  protected readonly action = 'enable';
}

@Command({
  name: 'agents',
  description: 'List and show the Agents, which notes define',
  subCommands: [
    AgentsListCommand,
    AgentsShowCommand,
    AgentsCreateCommand,
    AgentsEditCommand,
    AgentsDisableCommand,
    AgentsEnableCommand,
  ],
})
export class AgentsCommand extends CommandRunner {
  // `ls` is the default subcommand, so this only runs if that changes.
  async run(): Promise<void> {
    this.command.help();
  }
}
