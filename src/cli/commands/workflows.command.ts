import { Command, CommandRunner, Option, SubCommand } from 'nest-commander';
import type { WorkflowAction } from '../../settings-files/note-hints.js';
import { CliError } from '../errors.js';
import {
  formatWorkflowDetails,
  formatWorkflowList,
  runOutcome,
} from '../format-workflows.js';
import { workflowStub } from '../note-stubs.js';
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

/** A removed command that says which note to edit instead. */
abstract class WorkflowStubCommand extends PeroCommand {
  protected abstract readonly action: WorkflowAction;

  async run([name]: string[]): Promise<void> {
    await workflowStub(this.config(), this.action, name!);
  }
}

@SubCommand({
  name: 'create',
  arguments: '<name>',
  description: 'Removed: add a Workflow note instead; this says where',
  argsDescription: NAME,
  allowUnknownOptions: true,
})
export class WorkflowsCreateCommand extends WorkflowStubCommand {
  protected readonly action = 'create';
}

@SubCommand({
  name: 'edit',
  arguments: '<name>',
  description: "Removed: edit the Workflow's note instead; this says where",
  argsDescription: NAME,
  allowUnknownOptions: true,
})
export class WorkflowsEditCommand extends WorkflowStubCommand {
  protected readonly action = 'edit';
}

@SubCommand({
  name: 'disable',
  arguments: '<name>',
  description: "Removed: set enabled: false in the Workflow's note instead",
  argsDescription: NAME,
})
export class WorkflowsDisableCommand extends WorkflowStubCommand {
  protected readonly action = 'disable';
}

@SubCommand({
  name: 'enable',
  arguments: '<name>',
  description: "Removed: set enabled: true in the Workflow's note instead",
  argsDescription: NAME,
})
export class WorkflowsEnableCommand extends WorkflowStubCommand {
  protected readonly action = 'enable';
}

interface RunOptions {
  /** False with --no-wait. */
  wait?: boolean;
}

@SubCommand({
  name: 'run',
  arguments: '<name>',
  description:
    "Run a Workflow now, whatever its trigger, and print the Agent's answer",
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

@SubCommand({
  name: 'notify',
  arguments: '<name> [channel]',
  description:
    "Removed: name the topic in the channel of the Workflow's note instead",
  argsDescription: {
    ...NAME,
    channel: "the Channel's ID, as pero channels ls lists it",
  },
  allowUnknownOptions: true,
})
export class WorkflowsNotifyCommand extends PeroCommand {
  async run([name]: string[], options: { remove?: boolean }): Promise<void> {
    await workflowStub(
      this.config(),
      options.remove === true ? 'stop-notifying' : 'notify',
      name!,
    );
  }

  @Option({
    flags: '--remove',
    description: 'stop notifying the Channel',
  })
  parseRemove(): true {
    return true;
  }
}

@Command({
  name: 'workflows',
  description: 'List, show, and run the Workflows, which notes define',
  subCommands: [
    WorkflowsListCommand,
    WorkflowsShowCommand,
    WorkflowsCreateCommand,
    WorkflowsEditCommand,
    WorkflowsDisableCommand,
    WorkflowsEnableCommand,
    WorkflowsRunCommand,
    WorkflowsNotifyCommand,
  ],
})
export class WorkflowsCommand extends CommandRunner {
  // `ls` is the default subcommand, so this only runs if that changes.
  async run(): Promise<void> {
    this.command.help();
  }
}
