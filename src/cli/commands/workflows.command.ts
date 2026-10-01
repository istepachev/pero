import { Command, CommandRunner, Option, SubCommand } from 'nest-commander';
import { CliError } from '../errors.js';
import {
  formatWorkflowDetails,
  formatWorkflowList,
  runOutcome,
} from '../format-workflows.js';
import { PeroCommand } from '../pero-command.js';
import { waitForRun } from '../wait-for-run.js';

const NAME = { name: "the Workflow's name, as pero workflows ls lists it" };

@SubCommand({
  name: 'ls',
  description: 'List the Workflows',
  options: { isDefault: true },
})
export class WorkflowsListCommand extends PeroCommand {
  async run(): Promise<void> {
    const { client } = await this.requireDaemon();
    const { workflows } = await client.call('workflows.list');
    console.log(formatWorkflowList(workflows));
  }
}

@SubCommand({
  name: 'show',
  arguments: '<name>',
  description:
    'Show a Workflow: its note, Agent, input, schedule, and Channels',
  argsDescription: NAME,
})
export class WorkflowsShowCommand extends PeroCommand {
  async run([name]: string[]): Promise<void> {
    const { client } = await this.requireDaemon();
    console.log(
      formatWorkflowDetails(
        await client.call('workflows.get', { name: name! }),
      ),
    );
  }
}

interface RunOptions {
  /** False with --no-wait. */
  wait?: boolean;
}

@SubCommand({
  name: 'run',
  arguments: '<name>',
  description:
    "Run a Workflow now, with a schedule or without, and print the Agent's answer",
  argsDescription: NAME,
})
export class WorkflowsRunCommand extends PeroCommand {
  async run([name]: string[], options: RunOptions): Promise<void> {
    const { client } = await this.requireDaemon();
    const run = await client.call('workflows.run', { name: name! });
    if (options.wait === false) {
      console.log(
        `Queued run ${run.id} of Workflow ${run.workflow}; it runs in the background.`,
      );
      return;
    }
    console.error(`Queued run ${run.id} of Workflow ${run.workflow}…`);
    const outcome = runOutcome(await waitForRun(client, run));
    if (!outcome.ok) throw new CliError(outcome.text);
    console.log(outcome.text);
  }

  @Option({
    flags: '--no-wait',
    description: 'queue the run and return without waiting for it',
  })
  parseNoWait(): false {
    return false;
  }
}

@Command({
  name: 'workflows',
  description: 'List, show, and run the Workflows, which notes define',
  subCommands: [
    WorkflowsListCommand,
    WorkflowsShowCommand,
    WorkflowsRunCommand,
  ],
})
export class WorkflowsCommand extends CommandRunner {
  // `ls` is the default subcommand, so this only runs if that changes.
  async run(): Promise<void> {
    this.command.help();
  }
}
