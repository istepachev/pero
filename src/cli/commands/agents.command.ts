import { homedir } from 'node:os';
import { Command, CommandRunner, Option, SubCommand } from 'nest-commander';
import type { AgentEdit } from '../../config/agent-input.js';
import type { AgentDetails } from '../../control/protocol.js';
import {
  type AgentOptions,
  agentChange,
  renameAgentFields,
} from '../agent-options.js';
import { CliError } from '../errors.js';
import {
  formatAgentDetails,
  formatAgentList,
  sessionEffect,
  summarize,
} from '../format-agents.js';
import { withOptionNames } from '../option-names.js';
import { PeroCommand } from '../pero-command.js';
import { readStdin } from '../prompts.js';

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

/**
 * The options `create` and `edit` share. Each `--x` is declared before its
 * `--no-x`: commander otherwise defaults the option to true.
 */
abstract class AgentOptionsCommand extends PeroCommand {
  /** The change `options` describe, with folders and stdin resolved. */
  protected change(options: AgentOptions): Promise<AgentEdit> {
    return agentChange(options, {
      cwd: process.cwd(),
      home: homedir(),
      stdin: readStdin,
    });
  }

  @Option({ flags: '--title <title>', description: 'a display name' })
  parseTitle(value: string): string {
    return value;
  }

  @Option({ flags: '--no-title', description: 'show the name instead' })
  parseNoTitle(): false {
    return false;
  }

  @Option({ flags: '--provider <provider>', description: 'claude or codex' })
  parseProvider(value: string): string {
    return value;
  }

  @Option({ flags: '--model <model>', description: 'the model to use' })
  parseModel(value: string): string {
    return value;
  }

  @Option({ flags: '--no-model', description: "the provider's default model" })
  parseNoModel(): false {
    return false;
  }

  @Option({
    flags: '--effort <level>',
    description:
      'reasoning effort: low, medium, high, xhigh, or max for claude; minimal to persistent for codex',
  })
  parseEffort(value: string): string {
    return value;
  }

  @Option({
    flags: '--no-effort',
    description: "the provider's default effort",
  })
  parseNoEffort(): false {
    return false;
  }

  @Option({
    flags: '--working-directory <folder>',
    description:
      'a folder of its own, relative to the current folder or ~; without one it follows the default working directory',
  })
  parseWorkingDirectory(value: string): string {
    return value;
  }

  @Option({
    flags: '--instructions <text>',
    description: 'its own instructions; - reads them from stdin',
  })
  parseInstructions(value: string): string {
    return value;
  }

  @Option({
    flags: '--no-instructions',
    description: 'no instructions of its own',
  })
  parseNoInstructions(): false {
    return false;
  }

  @Option({
    flags: '--shared-instructions',
    description: 'put the shared instructions before its own (the default)',
  })
  parseSharedInstructions(): true {
    return true;
  }

  @Option({
    flags: '--no-shared-instructions',
    description: 'leave out the shared instructions',
  })
  parseNoSharedInstructions(): false {
    return false;
  }

  @Option({
    flags: '--permissions <mode>',
    description:
      'ask: tools beyond its folder ask in the chat (Codex: sandboxed to the folder); bypass: every tool runs without asking',
  })
  parsePermissions(value: string): string {
    return value;
  }

  @Option({
    flags: '--skip-git-repo-check',
    description:
      'let a Codex Agent work in a folder that is not a Git repository',
  })
  parseSkipGitRepoCheck(): true {
    return true;
  }

  @Option({
    flags: '--no-skip-git-repo-check',
    description: 'require a Git repository for a Codex Agent (the default)',
  })
  parseNoSkipGitRepoCheck(): false {
    return false;
  }
}

@SubCommand({
  name: 'create',
  arguments: '<name>',
  description:
    'Create an Agent; what is not given comes from the installation settings',
  argsDescription: {
    name: 'letters and digits in words joined by hyphens, such as daily-brief',
  },
})
export class AgentsCreateCommand extends AgentOptionsCommand {
  async run([name]: string[], options: AgentOptions): Promise<void> {
    const change = await this.change(options);
    const { client } = await this.requireDaemon();
    const agent = await withOptionNames(
      () => client.call('agents.create', { name: name!, ...change }),
      renameAgentFields,
    );
    console.log(`Created Agent ${agent.name}: ${summarize(agent)}`);
    warnAboutFolder(agent);
  }
}

@SubCommand({
  name: 'edit',
  arguments: '<name>',
  description:
    'Change an Agent; a new provider or folder starts fresh Sessions that carry over recent messages',
  argsDescription: NAME,
})
export class AgentsEditCommand extends AgentOptionsCommand {
  async run([name]: string[], options: AgentOptions): Promise<void> {
    const change = await this.change(options);
    if (Object.keys(change).length === 0) {
      throw new CliError(
        'Nothing to change; see pero agents edit --help for the options',
      );
    }
    const { client } = await this.requireDaemon();
    const agent = await withOptionNames(
      () => client.call('agents.edit', { name: name!, change }),
      renameAgentFields,
    );
    console.log(`Changed Agent ${agent.name}: ${summarize(agent)}`);
    const effect = sessionEffect(
      agent,
      change.providerOptions !== undefined ||
        change.instructions !== undefined ||
        change.useSharedInstructions !== undefined ||
        change.permissions !== undefined,
    );
    if (effect !== null) console.log(effect);
    warnAboutFolder(agent);
  }

  @Option({
    flags: '--follow-default',
    description:
      'give up its own folder and follow the default working directory',
  })
  parseFollowDefault(): true {
    return true;
  }
}

@SubCommand({
  name: 'disable',
  arguments: '<name>',
  description:
    'Stop an Agent from answering; its Channels and Sessions are kept',
  argsDescription: NAME,
})
export class AgentsDisableCommand extends PeroCommand {
  async run([name]: string[]): Promise<void> {
    const { client } = await this.requireDaemon();
    const agent = await client.call('agents.edit', {
      name: name!,
      change: { enabled: false },
    });
    console.log(
      `Disabled Agent ${agent.name}. Its Channels get no answer until pero agents enable ${agent.name}.`,
    );
    if (agent.main) {
      console.error(
        `Warning: ${agent.name} is the main Agent, so General topics and direct chats get no answer either; pero settings set main-agent <name> chooses another for new ones.`,
      );
    }
  }
}

@SubCommand({
  name: 'enable',
  arguments: '<name>',
  description: 'Let a disabled Agent answer again, once its folder is usable',
  argsDescription: NAME,
})
export class AgentsEnableCommand extends PeroCommand {
  async run([name]: string[]): Promise<void> {
    const { client } = await this.requireDaemon();
    const agent = await client.call('agents.edit', {
      name: name!,
      change: { enabled: true },
    });
    console.log(`Enabled Agent ${agent.name}: ${summarize(agent)}`);
  }
}

@Command({
  name: 'agents',
  description: 'List, show, create, and change Agents',
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

function warnAboutFolder(agent: AgentDetails): void {
  if (agent.folderProblem !== null) {
    console.error(`Warning: ${agent.folderProblem}`);
  }
}
