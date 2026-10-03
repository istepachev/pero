import { createHash } from 'node:crypto';
import type {
  RunDetails,
  RunView,
  WorkflowView,
} from '../../control/protocol.js';
import { localTime } from '../../history/transcript.js';
import type { RunStatus } from '../../persistence/entities/sql.js';
import {
  MAX_BUTTON_ID_BYTES,
  type OutboundButton,
} from '../channel-adapter.js';
import type { Screen } from './screens.js';

/*
 * What the Workflow commands answer. Pure, so every screen is tested
 * without a bot. A button names a Workflow by its name, or by `~` and a
 * hash of it when the name is too long for a button's ID.
 */

/** The commands that take a Workflow, and the longest of them. */
type WorkflowAction = 'workflows' | 'run' | 'runs';
const LONGEST_ACTION = '/workflows ';

/** How a button names Workflow `name`: itself, or a hash when too long. */
export function workflowRef(name: string): string {
  return Buffer.byteLength(`${LONGEST_ACTION}${name}`) <= MAX_BUTTON_ID_BYTES
    ? name
    : `~${createHash('sha256').update(name).digest('base64url').slice(0, 10)}`;
}

/** Runs that can still be cancelled. */
export const CANCELLABLE: readonly RunStatus[] = ['pending', 'running'];

/** Runs that can be retried, once each. */
export const RETRYABLE: readonly RunStatus[] = [
  'failed',
  'interrupted',
  'cancelled',
];

/** A Workflow as the list shows it: its view and its latest run. */
export interface WorkflowItem {
  view: WorkflowView;
  lastRun: RunView | null;
}

const WORKFLOWS: OutboundButton = { id: '/workflows', label: '« Workflows' };

/**
 * `/workflows`, or the Workflow picker of `/run` and `/runs`: a line per
 * Workflow, and a button per Workflow that does `action` with it.
 * `problem`, such as a name that matched nothing, comes first.
 */
export function workflowsScreen(
  items: readonly WorkflowItem[],
  action: WorkflowAction,
  options: { problem?: string | null; folder: string; timezone: string },
): Screen {
  const problem = options.problem ?? null;
  if (items.length === 0) {
    return {
      text: [
        ...(problem === null ? [] : [problem]),
        `No Workflows yet. Ask Pero to create one, or add a note to ${options.folder}.`,
      ].join('\n'),
    };
  }
  const heading = {
    workflows: 'Workflows:',
    run: 'Which Workflow should run now?',
    runs: 'Whose runs?',
  }[action];
  const buttons = items.map(({ view }) => ({
    id: `/${action} ${workflowRef(view.name)}`,
    label: view.title,
  }));
  return {
    text: [
      ...(problem === null ? [] : [problem]),
      heading,
      ...items.map(
        (item) => `• ${item.view.title} — ${when(item, options.timezone)}`,
      ),
    ].join('\n'),
    buttons: [
      ...rows(buttons, 2),
      ...(action === 'workflows' ? [] : [[WORKFLOWS]]),
    ],
  };
}

/** When a Workflow runs, and how its latest run went. */
function when({ view, lastRun }: WorkflowItem, timezone: string): string {
  const schedule = view.schedule;
  const next =
    schedule === null
      ? 'by hand only'
      : !view.enabled
        ? 'disabled: by hand only'
        : schedule.nextRunAt === null
          ? 'not scheduled yet'
          : `next ${localTime(new Date(schedule.nextRunAt), schedule.timezone)}`;
  const last =
    lastRun === null
      ? ''
      : ` · last run #${lastRun.id} ${lastRun.status} ${localTime(new Date(lastRun.createdAt), timezone)}`;
  return `${next}${last}`;
}

/** `/workflows <name>`: one Workflow, its latest runs, and what to do. */
export function workflowScreen(
  view: WorkflowView,
  runs: readonly RunView[],
  timezone: string,
): Screen {
  const { schedule } = view;
  const ref = workflowRef(view.name);
  const lines = [
    `Workflow ${view.title}`,
    `Config: ${view.file}`,
    `Channel note: ${view.note}${view.noteEnabled ? '' : ' (disabled, so it cannot run)'}`,
    `Schedule: ${
      schedule === null
        ? 'none, it runs by hand'
        : `${schedule.cron} (${schedule.timezone})${
            view.enabled
              ? schedule.nextRunAt === null
                ? ''
                : ` · next ${localTime(new Date(schedule.nextRunAt), schedule.timezone)}`
              : ' · disabled, so only by hand'
          }`
    }`,
    `Posts to: ${
      view.channels.length === 0
        ? 'no topic'
        : view.channels
            .map((channel) => channel.title ?? channel.key)
            .join(', ')
    }`,
  ];
  if (runs.length > 0) {
    lines.push(
      'Latest runs:',
      ...runs.map((run) => `  ${runLine(run, timezone)}`),
    );
  }
  if (view.errors.length > 0) {
    lines.push(
      'Note errors, so its last good version is in use:',
      ...view.errors.map(
        ({ property, message }) =>
          `  ${property === null ? '' : `${property}: `}${message}`,
      ),
    );
  }
  return {
    text: lines.join('\n'),
    buttons: [
      [
        { id: `/run ${ref}`, label: 'Run now' },
        { id: `/runs ${ref}`, label: 'Runs' },
      ],
      [WORKFLOWS],
    ],
  };
}

/**
 * `/runs`, or the run picker of `/cancel` and `/retry`: a line per run,
 * newest first, and a button per run. `/runs` opens a run; the pickers act
 * on it. `title` names the Workflow the runs belong to, when one does.
 */
export function runsScreen(
  runs: readonly RunView[],
  action: 'runs' | 'cancel' | 'retry',
  options: {
    title: (name: string) => string;
    workflow: string | null;
    problem?: string | null;
    timezone: string;
  },
): Screen {
  const problem = options.problem ?? null;
  const whose =
    options.workflow === null ? '' : ` of ${options.title(options.workflow)}`;
  if (runs.length === 0) {
    const none = {
      runs: `No runs${whose} yet.`,
      cancel: 'No run is waiting or running, so there is nothing to cancel.',
      retry: 'No run failed, was interrupted, or was cancelled lately.',
    }[action];
    return {
      text: [...(problem === null ? [] : [problem]), none].join('\n'),
      buttons: [[WORKFLOWS]],
    };
  }
  const heading = {
    runs: `Latest runs${whose}:`,
    cancel: 'Which run should be cancelled?',
    retry: 'Which run should run again?',
  }[action];
  const buttons = runs.map((run) => ({
    id: action === 'runs' ? `/runs #${run.id}` : `/${action} ${run.id}`,
    label: `#${run.id} ${run.status}`,
  }));
  return {
    text: [
      ...(problem === null ? [] : [problem]),
      heading,
      ...runs.map(
        (run) =>
          `• ${runLine(run, options.timezone, options.workflow === null ? options.title(run.workflow) : null)}`,
      ),
    ].join('\n'),
    buttons: [...rows(buttons, 3), [WORKFLOWS]],
  };
}

/** `#42 failed 2026-10-01 18:00`, with its Workflow when given. */
function runLine(run: RunView, timezone: string, title: string | null = null) {
  return (
    `#${run.id}${title === null ? '' : ` ${title}`} ${run.status} ` +
    localTime(new Date(run.createdAt), timezone)
  );
}

/** How much of a run's answer `/runs #<id>` shows. */
const ANSWER_PREVIEW = 600;

/** `/runs #<id>`: one run, how it went, and what can be done with it. */
export function runScreen(
  run: RunDetails,
  title: string,
  timezone: string,
): Screen {
  const times = [
    `queued ${localTime(new Date(run.createdAt), timezone)}`,
    ...(run.startedAt === null
      ? []
      : [`started ${localTime(new Date(run.startedAt), timezone)}`]),
    ...(run.finishedAt === null
      ? []
      : [`finished ${localTime(new Date(run.finishedAt), timezone)}`]),
  ];
  const lines = [
    `Run #${run.id} of ${title}: ${run.status}${run.attempt > 1 ? `, attempt ${run.attempt}` : ''}`,
    capitalized(times.join(' · ')),
  ];
  if (run.error !== null) lines.push(`Error: ${run.error}`);
  if (run.result !== null) {
    lines.push(
      `Answer: ${
        run.result.length > ANSWER_PREVIEW
          ? `${run.result.slice(0, ANSWER_PREVIEW - 1)}…`
          : run.result
      }`,
    );
  }
  if (run.retriedBy !== null) lines.push(`Retried by run #${run.retriedBy}.`);
  const actions: OutboundButton[] = [];
  if (CANCELLABLE.includes(run.status)) {
    actions.push({ id: `/cancel ${run.id}`, label: 'Cancel' });
  }
  if (RETRYABLE.includes(run.status) && run.retriedBy === null) {
    actions.push({ id: `/retry ${run.id}`, label: 'Retry' });
  }
  return {
    text: lines.join('\n'),
    buttons: [
      ...(actions.length === 0 ? [] : [actions]),
      [
        { id: `/runs ${workflowRef(run.workflow)}`, label: '« Runs' },
        WORKFLOWS,
      ],
    ],
  };
}

/** What `/run`, `/cancel`, or `/retry` did, with a way to follow it. */
export function runDoneScreen(text: string, run: RunView, by: string | null) {
  return {
    text: [text, ...(by === null ? [] : [`— ${by}`])].join('\n'),
    buttons: [
      [
        { id: `/runs #${run.id}`, label: `Run #${run.id}` },
        { id: `/runs ${workflowRef(run.workflow)}`, label: 'Runs' },
      ],
      [WORKFLOWS],
    ],
  };
}

function rows(
  buttons: readonly OutboundButton[],
  perRow: number,
): OutboundButton[][] {
  const result: OutboundButton[][] = [];
  for (let at = 0; at < buttons.length; at += perRow) {
    result.push(buttons.slice(at, at + perRow));
  }
  return result;
}

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
