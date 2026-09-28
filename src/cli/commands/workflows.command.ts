import { Command, CommandRunner, Option, SubCommand } from 'nest-commander';
import {
  MAX_ATTEMPTS_LIMIT,
  type WorkflowEdit,
} from '../../config/workflow-input.js';
import type { WorkflowView } from '../../control/protocol.js';
import { CliError } from '../errors.js';
import {
  agentWarning,
  formatWorkflowDetails,
  formatWorkflowList,
  runOutcome,
} from '../format-workflows.js';
import { withOptionNames } from '../option-names.js';
import { PeroCommand } from '../pero-command.js';
import { positiveInt } from '../positive-int.js';
import { readStdin } from '../prompts.js';
import { waitForRun } from '../wait-for-run.js';
import {
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
    const { agent, inputTemplate, title, maxAttempts } =
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
  description: "Change a Workflow's Agent, input, title, or attempts",
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

@Command({
  name: 'workflows',
  description: 'List, show, create, change, and run Workflows',
  subCommands: [
    WorkflowsListCommand,
    WorkflowsShowCommand,
    WorkflowsCreateCommand,
    WorkflowsEditCommand,
    WorkflowsDisableCommand,
    WorkflowsEnableCommand,
    WorkflowsRunCommand,
  ],
})
export class WorkflowsCommand extends CommandRunner {
  // `ls` is the default subcommand, so this only runs if that changes.
  async run(): Promise<void> {
    this.command.help();
  }
}

/** One line on a Workflow: its Agent and how many Triggers start it. */
function summarize(workflow: WorkflowView): string {
  const triggers =
    workflow.triggerCount === 1
      ? '1 Trigger'
      : `${workflow.triggerCount} Triggers`;
  return `runs Agent ${workflow.agent}, ${triggers}`;
}
