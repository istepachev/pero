import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConflictError, NotFoundError } from '../../common/errors.js';
import { slugify } from '../../config/slug.js';
import type { RunView, WorkflowView } from '../../control/protocol.js';
import type { RunStatus } from '../../persistence/entities/sql.js';
import { NOTE_FOLDERS } from '../../settings-files/note-files.js';
import { shownPath } from '../../settings-files/note-paths.js';
import { Definitions } from '../../settings/definitions.js';
import { SettingsNotes } from '../../settings/settings-notes.service.js';
import { WorkflowRuns } from '../../workflows/workflow-runs.service.js';
import { WorkflowViews } from '../../workflows/workflow-views.service.js';
import type { Answer } from './screens.js';
import {
  CANCELLABLE,
  RETRYABLE,
  runDoneScreen,
  runScreen,
  runsScreen,
  workflowRef,
  workflowScreen,
  workflowsScreen,
} from './workflow-screens.js';

/** How many runs a list of runs shows. */
const RUNS_SHOWN = 10;

/** How many runs a Workflow's own screen shows. */
const LATEST_RUNS = 5;

/** A run's ID as `/runs #42` or `/cancel 42` give it. */
const RUN_ID = /^#?(\d{1,9})$/;

/**
 * `/workflows`, `/run`, `/runs`, `/cancel`, and `/retry`: what the CLI's
 * `pero workflows` and `pero runs` do, with menus that pick a Workflow or
 * a run when the command names none, or one that doesn't exist.
 */
@Injectable()
export class WorkflowCommands {
  private readonly logger = new Logger('Channels');

  constructor(
    private readonly views: WorkflowViews,
    private readonly workflowRuns: WorkflowRuns,
    private readonly definitions: Definitions,
    private readonly notes: SettingsNotes,
  ) {}

  /** `/workflows`: the list; `/workflows <name>`: one Workflow. */
  async workflows(args: string): Promise<Answer> {
    const views = await this.views.list();
    if (args === '') return this.pick(views, 'workflows', null);
    const view = find(views, args);
    if (view === null) return this.pick(views, 'workflows', noWorkflow(args));
    const runs = await this.workflowRuns.list({
      workflow: view.name,
      limit: LATEST_RUNS,
    });
    return {
      screen: workflowScreen(view, runs, this.timezone()),
      notice: null,
    };
  }

  /** `/run <name>`: queues a run now; a picker without a known name. */
  async run(args: string, by: string | null): Promise<Answer> {
    const views = await this.views.list();
    const view = args === '' ? null : find(views, args);
    if (view === null) {
      return this.pick(views, 'run', args === '' ? null : noWorkflow(args));
    }
    const run = await this.workflowRuns.start(view.name);
    this.logger.log(
      `Run ${run.id} of Workflow ${view.name} queued from a chat`,
    );
    return {
      screen: runDoneScreen(`Queued run #${run.id} of ${view.title}.`, run, by),
      notice: 'Run queued',
    };
  }

  /**
   * `/runs`: the latest runs; `/runs <name>`: a Workflow's; `/runs #42`:
   * one run, with Cancel or Retry when they apply.
   */
  async runs(args: string): Promise<Answer> {
    const views = await this.views.list();
    const id = RUN_ID.exec(args);
    if (args.startsWith('#') && id !== null) {
      try {
        const run = await this.workflowRuns.get(Number(id[1]));
        return {
          screen: runScreen(run, title(views, run.workflow), this.timezone()),
          notice: null,
        };
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        return this.runList(views, null, `There is no run #${id[1]}.`);
      }
    }
    if (args === '') return this.runList(views, null, null);
    const view = find(views, args);
    if (view === null) return this.pick(views, 'runs', noWorkflow(args));
    return this.runList(views, view.name, null);
  }

  /** `/cancel 42`: cancels a run; a picker of those that can be. */
  async cancel(args: string, by: string | null): Promise<Answer> {
    const id = RUN_ID.exec(args);
    if (id === null) {
      return this.runPicker('cancel', CANCELLABLE, unknownRun(args));
    }
    let run: RunView;
    try {
      run = await this.workflowRuns.cancel(Number(id[1]));
    } catch (error) {
      if (!(error instanceof NotFoundError || error instanceof ConflictError)) {
        throw error;
      }
      return this.runPicker('cancel', CANCELLABLE, `${error.message}.`);
    }
    const name = title(await this.views.list(), run.workflow);
    return {
      screen: runDoneScreen(
        run.status === 'cancelled'
          ? `Cancelled run #${run.id} of ${name}.`
          : `Cancelling run #${run.id} of ${name}: its Agent is stopping.`,
        run,
        by,
      ),
      notice: 'Cancelled',
    };
  }

  /** `/retry 42`: runs a run again; a picker of those that can be. */
  async retry(args: string, by: string | null): Promise<Answer> {
    const id = RUN_ID.exec(args);
    if (id === null) {
      return this.runPicker('retry', RETRYABLE, unknownRun(args));
    }
    let result: Awaited<ReturnType<WorkflowRuns['retry']>>;
    try {
      result = await this.workflowRuns.retry(Number(id[1]));
    } catch (error) {
      if (!(error instanceof NotFoundError || error instanceof ConflictError)) {
        throw error;
      }
      return this.runPicker('retry', RETRYABLE, `${error.message}.`);
    }
    const { run, alsoReadBy } = result;
    const name = title(await this.views.list(), run.workflow);
    return {
      screen: runDoneScreen(
        `Queued run #${run.id} of ${name}, retrying run #${id[1]}.` +
          (alsoReadBy === null
            ? ''
            : ` Run #${alsoReadBy}, completed since, read some of the same messages.`),
        run,
        by,
      ),
      notice: 'Retry queued',
    };
  }

  private pick(
    views: readonly WorkflowView[],
    action: 'workflows' | 'run' | 'runs',
    problem: string | null,
  ): Promise<Answer> {
    return this.withLastRuns(views).then((items) => ({
      screen: workflowsScreen(items, action, {
        problem,
        folder: this.workflowsFolder(),
        timezone: this.timezone(),
      }),
      notice: null,
    }));
  }

  /** Each Workflow with its latest run. */
  private async withLastRuns(views: readonly WorkflowView[]) {
    return Promise.all(
      views.map(async (view) => ({
        view,
        lastRun:
          (
            await this.workflowRuns.list({ workflow: view.name, limit: 1 })
          )[0] ?? null,
      })),
    );
  }

  private async runList(
    views: readonly WorkflowView[],
    workflow: string | null,
    problem: string | null,
  ): Promise<Answer> {
    const runs = await this.workflowRuns.list({
      ...(workflow === null ? {} : { workflow }),
      limit: RUNS_SHOWN,
    });
    return {
      screen: runsScreen(runs, 'runs', {
        title: (name) => title(views, name),
        workflow,
        problem,
        timezone: this.timezone(),
      }),
      notice: null,
    };
  }

  /** The latest runs in one of `statuses`, to cancel or retry one. */
  private async runPicker(
    action: 'cancel' | 'retry',
    statuses: readonly RunStatus[],
    problem: string | null,
  ): Promise<Answer> {
    const views = await this.views.list();
    const found = await Promise.all(
      statuses.map((status) =>
        this.workflowRuns.list({ status, limit: RUNS_SHOWN }),
      ),
    );
    let runs = found.flat().sort((a, b) => b.id - a.id);
    if (action === 'retry') {
      // A run is retried once; one already retried has nothing left to do.
      const details = await Promise.all(
        runs.map((run) => this.workflowRuns.get(run.id)),
      );
      runs = runs.filter((_, at) => details[at]!.retriedBy === null);
    }
    runs = runs.slice(0, RUNS_SHOWN);
    return {
      screen: runsScreen(runs, action, {
        title: (name) => title(views, name),
        workflow: null,
        problem,
        timezone: this.timezone(),
      }),
      notice: null,
    };
  }

  private timezone(): string {
    return this.definitions.defaults().timezone;
  }

  private workflowsFolder(): string {
    const { workspace, settingsFolder } = this.notes.folders();
    return `${shownPath(workspace, join(settingsFolder, NOTE_FOLDERS.workflow))}/`;
  }
}

/**
 * The Workflow `ref` names: by its name, its title, or what its title
 * makes a name, in any case, or by the hash a button gives a long name.
 */
function find(
  views: readonly WorkflowView[],
  ref: string,
): WorkflowView | null {
  const wanted = ref.trim().toLowerCase();
  const slug = slugify(ref);
  return (
    views.find(
      (view) =>
        (ref.startsWith('~') && workflowRef(view.name) === ref) ||
        view.name === wanted ||
        view.title.toLowerCase() === wanted ||
        view.name === slug,
    ) ?? null
  );
}

/** The title of the Workflow named `name`, or the name once it is gone. */
function title(views: readonly WorkflowView[], name: string): string {
  return views.find((view) => view.name === name)?.title ?? name;
}

function noWorkflow(ref: string): string {
  return `There is no Workflow ${ref}.`;
}

/** Why a run ID can't be used; null when none was given. */
function unknownRun(args: string): string | null {
  return args === '' ? null : `${args} isn't a run's number.`;
}
