import { Command, CommandRunner, Option, SubCommand } from 'nest-commander';
import { DEFAULT_LISTED } from '../../control/protocol.js';
import {
  RUN_STATUSES,
  type RunStatus,
} from '../../persistence/entities/sql.js';
import { CliError } from '../errors.js';
import { runOutcome } from '../format-workflows.js';
import { formatRunDetails, formatRunList } from '../format-runs.js';
import { listLimit, oneOf } from '../list-options.js';
import { PeroCommand } from '../pero-command.js';
import { positiveInt } from '../positive-int.js';
import { waitForRun } from '../wait-for-run.js';

const RUN = { run: 'the run ID, as pero runs ls lists it' };

/** Run `value` as an ID; a `CliError` when it is not one. */
function runId(value: string): number {
  const id = positiveInt(value);
  if (id === null) {
    throw new CliError(`run must be a run ID, not "${value}"`);
  }
  return id;
}

interface RunsListOptions {
  workflow?: string;
  status?: RunStatus;
  lines?: number;
}

@SubCommand({
  name: 'ls',
  description: 'List the latest Workflow Runs, newest first',
  options: { isDefault: true },
})
export class RunsListCommand extends PeroCommand {
  async run(_: string[], options: RunsListOptions): Promise<void> {
    const { client } = await this.requireDaemon();
    const { runs } = await client.call('runs.list', {
      ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
      ...(options.status === undefined ? {} : { status: options.status }),
      limit: options.lines ?? DEFAULT_LISTED,
    });
    const filtered =
      options.workflow !== undefined || options.status !== undefined;
    console.log(formatRunList(runs, filtered));
  }

  @Option({
    flags: '--workflow <name>',
    description: "only this Workflow's runs",
  })
  parseWorkflow(value: string): string {
    return value;
  }

  @Option({
    flags: '--status <status>',
    description: `only runs with this status: ${RUN_STATUSES.join(', ')}`,
  })
  parseStatus(value: string): RunStatus {
    return oneOf('--status', value, RUN_STATUSES);
  }

  @Option({
    flags: '-n, --lines <count>',
    description: `how many runs to show (default: ${DEFAULT_LISTED})`,
  })
  parseLines(value: string): number {
    return listLimit(value);
  }
}

@SubCommand({
  name: 'show',
  arguments: '<run>',
  description:
    'Show a Workflow Run: how it ended, the history it read, and the Notifications it left',
  argsDescription: RUN,
})
export class RunsShowCommand extends PeroCommand {
  async run([run]: string[]): Promise<void> {
    const id = runId(run!);
    const { client } = await this.requireDaemon();
    console.log(formatRunDetails(await client.call('runs.get', { id })));
  }
}

interface RetryOptions {
  /** False with --no-wait. */
  wait?: boolean;
}

@SubCommand({
  name: 'retry',
  arguments: '<run>',
  description:
    "Run a failed, interrupted, or cancelled Workflow Run again and print Pero's answer",
  argsDescription: RUN,
})
export class RunsRetryCommand extends PeroCommand {
  async run([run]: string[], options: RetryOptions): Promise<void> {
    const id = runId(run!);
    const { client } = await this.requireDaemon();
    const { run: retry, alsoReadBy } = await client.call('runs.retry', { id });
    if (alsoReadBy !== null) {
      console.error(
        `Note: run ${alsoReadBy} has since read some of the Channel history this run reads again.`,
      );
    }
    if (options.wait === false) {
      console.log(
        `Queued run ${retry.id} to retry run ${id} of Workflow ${retry.workflow}; it runs in the background.`,
      );
      return;
    }
    console.error(
      `Queued run ${retry.id} to retry run ${id} of Workflow ${retry.workflow}…`,
    );
    const outcome = runOutcome(await waitForRun(client, retry));
    if (!outcome.ok) throw new CliError(outcome.text);
    console.log(outcome.text);
  }

  @Option({
    flags: '--no-wait',
    description: 'queue the retry and return without waiting for it',
  })
  parseNoWait(): false {
    return false;
  }
}

@SubCommand({
  name: 'cancel',
  arguments: '<run>',
  description:
    'Cancel a Workflow Run: one waiting to start never does, and a running one has its turn stopped',
  argsDescription: RUN,
})
export class RunsCancelCommand extends PeroCommand {
  async run([run]: string[]): Promise<void> {
    const id = runId(run!);
    const { client } = await this.requireDaemon();
    // A running run is recorded once its turn stops.
    const view = await waitForRun(
      client,
      await client.call('runs.cancel', { id }),
    );
    if (view.status === 'cancelled') {
      console.log(`Cancelled run ${view.id} of Workflow ${view.workflow}.`);
      return;
    }
    // It finished before the cancel reached it.
    const outcome = runOutcome(view);
    if (!outcome.ok) throw new CliError(outcome.text);
    console.log(outcome.text);
  }
}

@Command({
  name: 'runs',
  description: 'List, show, retry, and cancel Workflow Runs',
  subCommands: [
    RunsListCommand,
    RunsShowCommand,
    RunsRetryCommand,
    RunsCancelCommand,
  ],
})
export class RunsCommand extends CommandRunner {
  // `ls` is the default subcommand, so this only runs if that changes.
  async run(): Promise<void> {
    this.command.help();
  }
}
