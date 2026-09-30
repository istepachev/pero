import { Command, CommandRunner, SubCommand } from 'nest-commander';
import type { TriggerAction } from '../../settings-files/note-hints.js';
import { triggerStub } from '../note-stubs.js';
import { PeroCommand } from '../pero-command.js';

// Removed: a Workflow's note sets its schedule, and any Workflow runs by
// hand. Each command says what to edit instead and exits 1.

const TRIGGER = { trigger: "the Trigger's ID, as pero triggers ls listed it" };

const WORKFLOW = {
  workflow: "the Workflow's name, as pero workflows ls lists it",
};

/** A removed command that says what to do instead. */
abstract class TriggerStubCommand extends PeroCommand {
  protected abstract readonly action: TriggerAction;

  async run(): Promise<void> {
    await triggerStub(this.config(), this.action, null);
  }
}

@SubCommand({
  name: 'ls',
  arguments: '[workflow]',
  description: 'Removed: pero workflows ls shows each schedule',
  argsDescription: WORKFLOW,
  options: { isDefault: true },
})
export class TriggersListCommand extends TriggerStubCommand {
  protected readonly action = 'list';
}

@SubCommand({
  name: 'add',
  arguments: '<workflow>',
  description:
    "Removed: set the schedule in the Workflow's note instead; this says where",
  argsDescription: WORKFLOW,
  allowUnknownOptions: true,
})
export class TriggersAddCommand extends PeroCommand {
  async run([workflow]: string[]): Promise<void> {
    await triggerStub(this.config(), 'add', workflow!);
  }
}

@SubCommand({
  name: 'remove',
  arguments: '<trigger>',
  description: "Removed: set trigger: manual in the Workflow's note instead",
  argsDescription: TRIGGER,
})
export class TriggersRemoveCommand extends TriggerStubCommand {
  protected readonly action = 'remove';
}

@SubCommand({
  name: 'disable',
  arguments: '<trigger>',
  description: "Removed: set trigger: manual in the Workflow's note instead",
  argsDescription: TRIGGER,
})
export class TriggersDisableCommand extends TriggerStubCommand {
  protected readonly action = 'disable';
}

@SubCommand({
  name: 'enable',
  arguments: '<trigger>',
  description: "Removed: set trigger: schedule in the Workflow's note instead",
  argsDescription: TRIGGER,
})
export class TriggersEnableCommand extends TriggerStubCommand {
  protected readonly action = 'enable';
}

@Command({
  name: 'triggers',
  description: "Removed: Workflows' notes set their schedules",
  subCommands: [
    TriggersListCommand,
    TriggersAddCommand,
    TriggersRemoveCommand,
    TriggersDisableCommand,
    TriggersEnableCommand,
  ],
})
export class TriggersCommand extends CommandRunner {
  // `ls` is the default subcommand, so this only runs if that changes.
  async run(): Promise<void> {
    this.command.help();
  }
}
