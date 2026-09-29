import { Command, CommandRunner, Option, SubCommand } from 'nest-commander';
import {
  HISTORY_MESSAGES,
  type HistoryMessages,
  MAX_ATTEMPTS_LIMIT,
  MAX_HISTORY_HOURS,
  type WorkflowEdit,
} from '../../config/workflow-input.js';
import type { WorkflowView } from '../../control/protocol.js';
import { channelId } from '../channel-id.js';
import { CliError } from '../errors.js';
import {
  agentWarning,
  formatWorkflowDetails,
  formatNotify,
  formatWorkflowList,
  runOutcome,
} from '../format-workflows.js';
import { withOptionNames } from '../option-names.js';
import { PeroCommand } from '../pero-command.js';
import { positiveInt } from '../positive-int.js';
import { readStdin } from '../prompts.js';
import { waitForRun } from '../wait-for-run.js';
import {
  parseHistoryChannels,
  renameWorkflowFields,
  type WorkflowOptions,
  workflowChange,
} from '../workflow-options.js';

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
  description: 'Show a Workflow, its Agent and input, and its Triggers',
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

/**
 * The options `create` and `edit` share. Each `--x` is declared before its
 * `--no-x`: commander otherwise defaults the option to true.
 */
abstract class WorkflowOptionsCommand extends PeroCommand {
  /** The change `options` describe, with stdin read. */
  protected change(options: WorkflowOptions): Promise<WorkflowEdit> {
    return workflowChange(options, { stdin: readStdin });
  }

  @Option({
    flags: '--agent <name>',
    description: 'the enabled Agent its runs use',
  })
  parseAgent(value: string): string {
    return value;
  }

  @Option({
    flags: '--input <text>',
    description: 'what each run sends to the Agent; - reads it from stdin',
  })
  parseInput(value: string): string {
    return value;
  }

  @Option({ flags: '--title <title>', description: 'a display name' })
  parseTitle(value: string): string {
    return value;
  }

  @Option({ flags: '--no-title', description: 'show the name instead' })
  parseNoTitle(): false {
    return false;
  }

  @Option({
    flags: '--max-attempts <n>',
    description: `how many times a run may start in all: a run Pero stopped before it finished starts again on the next start until it has started this often (1 to ${MAX_ATTEMPTS_LIMIT}; default 1, never again)`,
  })
  parseMaxAttempts(value: string): number {
    const count = positiveInt(value);
    if (count === null) {
      throw new CliError(
        `--max-attempts must be a positive whole number, not "${value}"`,
      );
    }
    return count;
  }

  @Option({
    flags: '--history',
    description:
      "put Channel history in each run's input, at {{history}} or after it: by default what people wrote in every Channel since the previous run (the last 24 hours for the first)",
  })
  parseHistory(): true {
    return true;
  }

  @Option({
    flags: '--no-history',
    description: 'stop putting Channel history in the input',
  })
  parseNoHistory(): false {
    return false;
  }

  @Option({
    flags: '--history-channels <ids>',
    description:
      'the Channels whose history runs read: IDs separated by commas, as pero channels ls lists them, or all',
  })
  parseHistoryChannels(value: string): 'all' | number[] {
    return parseHistoryChannels(value);
  }

  @Option({
    flags: '--history-messages <which>',
    description:
      "people (only what people wrote) or all (the Agents' replies too)",
  })
  parseHistoryMessages(value: string): HistoryMessages {
    const which = value.trim().toLowerCase();
    if (!(HISTORY_MESSAGES as readonly string[]).includes(which)) {
      throw new CliError(
        `--history-messages must be people or all, not "${value}"`,
      );
    }
    return which as HistoryMessages;
  }

  @Option({
    flags: '--history-hours <n>',
    description: `read a fixed window: the last n hours before each run (1 to ${MAX_HISTORY_HOURS})`,
  })
  parseHistoryHours(value: string): number {
    const hours = positiveInt(value);
    if (hours === null) {
      throw new CliError(
        `--history-hours must be a positive whole number, not "${value}"`,
      );
    }
    return hours;
  }

  @Option({
    flags: '--history-since-last-run',
    description:
      'read everything since the previous successful run, once each (the default)',
  })
  parseHistorySinceLastRun(): true {
    return true;
  }

  @Option({
    flags: '--run-when-empty',
    description:
      'run the Agent even when there is no history to read; by default such a run completes without it',
  })
  parseRunWhenEmpty(): true {
    return true;
  }

  @Option({
    flags: '--no-run-when-empty',
    description: 'complete a run with no history to read without the Agent',
  })
  parseNoRunWhenEmpty(): false {
    return false;
  }
}

@SubCommand({
  name: 'create',
  arguments: '<name>',
  description:
    'Create a Workflow: an Agent and the input each run sends it; pero triggers add starts it',
  argsDescription: {
    name: 'letters and digits in words joined by hyphens, such as evening-review',
  },
})
export class WorkflowsCreateCommand extends WorkflowOptionsCommand {
  async run([name]: string[], options: WorkflowOptions): Promise<void> {
    if (options.agent === undefined) {
      throw new CliError('Give the Agent its runs use with --agent <name>');
    }
    if (options.input === undefined) {
      throw new CliError(
        'Give what each run sends the Agent with --input <text> (- reads stdin)',
      );
    }
    const { agent, inputTemplate, title, maxAttempts, history } =
      await this.change(options);
    const { client } = await this.requireDaemon();
    const workflow = await withOptionNames(
      () =>
        client.call('workflows.create', {
          name: name!,
          agent: agent!,
          inputTemplate: inputTemplate!,
          ...(title === undefined ? {} : { title }),
          ...(maxAttempts === undefined ? {} : { maxAttempts }),
          // A new Workflow reads no history until asked.
          ...(history === undefined || history === null ? {} : { history }),
        }),
      renameWorkflowFields,
    );
    console.log(`Created Workflow ${workflow.name}: ${summarize(workflow)}`);
    console.log(
      `Start it on a schedule with pero triggers add ${workflow.name} --cron "<expression>".`,
    );
  }
}

@SubCommand({
  name: 'edit',
  arguments: '<name>',
  description:
    "Change a Workflow's Agent, input, title, attempts, or history input",
  argsDescription: NAME,
})
export class WorkflowsEditCommand extends WorkflowOptionsCommand {
  async run([name]: string[], options: WorkflowOptions): Promise<void> {
    const change = await this.change(options);
    if (Object.keys(change).length === 0) {
      throw new CliError(
        'Nothing to change; see pero workflows edit --help for the options',
      );
    }
    const { client } = await this.requireDaemon();
    const workflow = await withOptionNames(
      () => client.call('workflows.edit', { name: name!, change }),
      renameWorkflowFields,
    );
    console.log(`Changed Workflow ${workflow.name}: ${summarize(workflow)}`);
  }
}

@SubCommand({
  name: 'disable',
  arguments: '<name>',
  description: 'Stop a Workflow from running; its Triggers are kept',
  argsDescription: NAME,
})
export class WorkflowsDisableCommand extends PeroCommand {
  async run([name]: string[]): Promise<void> {
    const { client } = await this.requireDaemon();
    const workflow = await client.call('workflows.edit', {
      name: name!,
      change: { enabled: false },
    });
    console.log(
      `Disabled Workflow ${workflow.name}. Its Triggers start nothing until pero workflows enable ${workflow.name}.`,
    );
  }
}

@SubCommand({
  name: 'enable',
  arguments: '<name>',
  description: 'Let a disabled Workflow run again',
  argsDescription: NAME,
})
export class WorkflowsEnableCommand extends PeroCommand {
  async run([name]: string[]): Promise<void> {
    const { client } = await this.requireDaemon();
    const workflow = await client.call('workflows.edit', {
      name: name!,
      change: { enabled: true },
    });
    console.log(`Enabled Workflow ${workflow.name}: ${summarize(workflow)}`);
    const warning = agentWarning(workflow);
    if (warning !== null) console.error(warning);
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
    "Run a Workflow now through its manual Trigger and print the Agent's answer",
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
  arguments: '<name> <channel>',
  description:
    "Post a Workflow's answers, and its failed runs, to a Channel; --remove stops it",
  argsDescription: {
    ...NAME,
    channel: "the Channel's ID, as pero channels ls lists it",
  },
})
export class WorkflowsNotifyCommand extends PeroCommand {
  async run(
    [name, channel]: string[],
    options: { remove?: boolean },
  ): Promise<void> {
    const id = channelId(channel!);
    const notify = options.remove !== true;
    const { client } = await this.requireDaemon();
    const { workflow, changed } = await client.call('workflows.notify', {
      name: name!,
      channel: id,
      notify,
    });
    console.log(formatNotify(workflow, id, notify, changed));
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
  description:
    'List, show, create, change, and run Workflows, and choose the Channels they notify',
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

/**
 * One line on a Workflow: its Agent, whether it reads history, and how many
 * Triggers start it.
 */
function summarize(workflow: WorkflowView): string {
  const triggers =
    workflow.triggerCount === 1
      ? '1 Trigger'
      : `${workflow.triggerCount} Triggers`;
  const history = workflow.history === null ? '' : ', reads Channel history';
  return `runs Agent ${workflow.agent}${history}, ${triggers}`;
}
