import { Command, CommandRunner, SubCommand } from 'nest-commander';
import { CliError } from '../errors.js';
import { runOutcome } from '../format-workflows.js';
import { PeroCommand } from '../pero-command.js';
import { positiveInt } from '../positive-int.js';
import { waitForRun } from '../wait-for-run.js';

@SubCommand({
  name: 'cancel',
  arguments: '<run>',
  description:
    'Cancel a Workflow Run: one waiting to start never does, and a running one has its Agent stopped',
  argsDescription: { run: 'the run ID, as pero workflows run prints it' },
})
export class RunsCancelCommand extends PeroCommand {
  async run([run]: string[]): Promise<void> {
    const id = positiveInt(run!);
    if (id === null) {
      throw new CliError(`run must be a run ID, not "${run}"`);
    }
    const { client } = await this.requireDaemon();
    // A running run is recorded once its Agent's turn stops.
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
  description: 'Cancel Workflow Runs',
  subCommands: [RunsCancelCommand],
})
export class RunsCommand extends CommandRunner {
  async run(): Promise<void> {
    this.command.help();
  }
}
