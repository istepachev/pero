import { Command, CommandRunner, Option, SubCommand } from 'nest-commander';
import { CliError } from '../errors.js';
import {
  describeScheduledTrigger,
  describeTrigger,
  formatTriggerList,
} from '../format-workflows.js';
import { withOptionNames } from '../option-names.js';
import { PeroCommand } from '../pero-command.js';
import { positiveInt } from '../positive-int.js';
import {
  renameWorkflowFields,
  type TriggerOptions,
  triggerKind,
} from '../workflow-options.js';

const TRIGGER = { trigger: "the Trigger's ID, as pero triggers ls lists it" };

const WORKFLOW = "the Workflow's name, as pero workflows ls lists it";

@SubCommand({
  name: 'ls',
  arguments: '[workflow]',
  description: "List the Triggers, or one Workflow's",
  argsDescription: { workflow: WORKFLOW },
  options: { isDefault: true },
})
export class TriggersListCommand extends PeroCommand {
  async run([workflow]: string[]): Promise<void> {
    const { client } = await this.requireDaemon();
    const { triggers } = await client.call(
      'triggers.list',
      workflow === undefined ? {} : { workflow },
    );
    console.log(formatTriggerList(triggers));
  }
}

@SubCommand({
  name: 'add',
  arguments: '<workflow>',
  description:
    'Start a Workflow on a cron schedule (--cron), or allow manual runs (--manual)',
  argsDescription: { workflow: WORKFLOW },
})
export class TriggersAddCommand extends PeroCommand {
  async run([workflow]: string[], options: TriggerOptions): Promise<void> {
    const kind = triggerKind(options);
    const { client } = await this.requireDaemon();
    const trigger = await withOptionNames(
      () => client.call('triggers.add', { workflow: workflow!, ...kind }),
      renameWorkflowFields,
    );
    console.log(`Added ${describeScheduledTrigger(trigger)}.`);
  }

  @Option({
    flags: '--cron <expression>',
    description:
      'minute hour day month weekday, such as "0 9 * * *" for 9:00 every day, or @daily',
  })
  parseCron(value: string): string {
    return value;
  }

  @Option({
    flags: '--timezone <zone>',
    description:
      'the IANA time zone the schedule follows, such as Europe/Berlin (default: the timezone setting)',
  })
  parseTimezone(value: string): string {
    return value;
  }

  @Option({
    flags: '--manual',
    description: 'a Trigger for runs started by hand',
  })
  parseManual(): true {
    return true;
  }
}

@SubCommand({
  name: 'remove',
  arguments: '<trigger>',
  description: 'Remove a Trigger; the runs it started are kept',
  argsDescription: TRIGGER,
})
export class TriggersRemoveCommand extends PeroCommand {
  async run([trigger]: string[]): Promise<void> {
    const id = triggerId(trigger!);
    const { client } = await this.requireDaemon();
    const removed = await client.call('triggers.remove', { id });
    console.log(`Removed ${describeTrigger(removed)}.`);
  }
}

@SubCommand({
  name: 'disable',
  arguments: '<trigger>',
  description: 'Stop a Trigger from starting its Workflow; it is kept',
  argsDescription: TRIGGER,
})
export class TriggersDisableCommand extends PeroCommand {
  async run([trigger]: string[]): Promise<void> {
    const id = triggerId(trigger!);
    const { client } = await this.requireDaemon();
    const view = await client.call('triggers.setEnabled', {
      id,
      enabled: false,
    });
    console.log(
      `Disabled ${describeTrigger(view)}. It starts nothing until pero triggers enable ${id}.`,
    );
  }
}

@SubCommand({
  name: 'enable',
  arguments: '<trigger>',
  description: 'Let a disabled Trigger start its Workflow again',
  argsDescription: TRIGGER,
})
export class TriggersEnableCommand extends PeroCommand {
  async run([trigger]: string[]): Promise<void> {
    const id = triggerId(trigger!);
    const { client } = await this.requireDaemon();
    const view = await client.call('triggers.setEnabled', {
      id,
      enabled: true,
    });
    console.log(`Enabled ${describeScheduledTrigger(view)}.`);
  }
}

@Command({
  name: 'triggers',
  description:
    'List, add, remove, and switch the Triggers that start Workflows',
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

/** The Trigger ID the owner typed; a `CliError` when it is not one. */
function triggerId(value: string): number {
  const id = positiveInt(value);
  if (id === null) {
    throw new CliError(
      `trigger must be a Trigger ID, as pero triggers ls lists it, not "${value}"`,
    );
  }
  return id;
}
