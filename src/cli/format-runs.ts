import type { RunDetails, RunView } from '../control/protocol.js';
import { localDateTime } from './format-channels.js';
import { notificationTable } from './format-notifications.js';
import { table } from './format-status.js';

/** `pero runs ls`: one row per run, newest first. */
export function formatRunList(
  runs: readonly RunView[],
  filtered: boolean,
): string {
  if (runs.length === 0) {
    return filtered
      ? 'No runs match.'
      : 'No runs yet. pero workflows run <name> starts one by hand.';
  }
  return table([
    [
      'ID',
      'WORKFLOW',
      'STATUS',
      'ATTEMPT',
      'STARTED BY',
      'CREATED',
      'FINISHED',
    ],
    ...runs.map((run) => [
      String(run.id),
      run.workflow,
      status(run),
      String(run.attempt),
      startedBy(run),
      localDateTime(new Date(run.createdAt)),
      run.finishedAt === null ? '—' : localDateTime(new Date(run.finishedAt)),
    ]),
  ]).join('\n');
}

/**
 * `pero runs show`: the run, the history it read, its answer or error,
 * and the Notifications it left.
 */
export function formatRunDetails(run: RunDetails): string {
  const lines = [
    `Run ${run.id} of Workflow ${run.workflow}`,
    ...table([
      ['status', status(run)],
      ['attempt', String(run.attempt)],
      ['started by', startedBy(run)],
      ...(run.skippedCount > 0
        ? [['coalesced', `${run.skippedCount} later scheduled times`]]
        : []),
      ['created', localDateTime(new Date(run.createdAt))],
      ['started', time(run.startedAt)],
      ['finished', time(run.finishedAt)],
      ...(run.retriedBy === null
        ? []
        : [['retried by', `run ${run.retriedBy}`]]),
      ...(run.history === null ? [] : [['history', history(run.history)]]),
    ]).map((row) => `  ${row}`),
  ];
  if (run.result !== null) lines.push('', 'Answer', ...indent(run.result));
  if (run.error !== null) lines.push('', 'Error', ...indent(run.error));
  lines.push('');
  if (run.notifications.length === 0) {
    lines.push('Notified no Channel.');
  } else {
    lines.push(
      'Notifications',
      ...notificationTable(run.notifications, false).map((row) => `  ${row}`),
    );
  }
  if (retryable(run)) {
    lines.push('', `pero runs retry ${run.id} queues it again.`);
  }
  return lines.join('\n');
}

/**
 * What started a run, from its trigger key: `manual`, `schedule`, or
 * `retry of run 5`.
 */
export function startedBy(run: Pick<RunView, 'triggerKey'>): string {
  const retry = /^retry:(\d+)$/.exec(run.triggerKey);
  if (retry !== null) return `retry of run ${retry[1]}`;
  const kind = run.triggerKey.split(':')[0]!;
  return kind === 'schedule' || kind === 'manual' ? kind : run.triggerKey;
}

/** Whether `pero runs retry` takes the run. */
function retryable(run: RunDetails): boolean {
  return (
    run.retriedBy === null &&
    (run.status === 'failed' ||
      run.status === 'interrupted' ||
      run.status === 'cancelled')
  );
}

function status(run: RunView): string {
  return run.status === 'completed' && run.skipped
    ? 'completed (skipped: no messages)'
    : run.status;
}

/** `12 messages from all Channels, people only (3 oldest left out)`. */
function history(read: NonNullable<RunDetails['history']>): string {
  const count = read.count === 1 ? '1 message' : `${read.count} messages`;
  const channels =
    read.channels === 'all'
      ? 'all Channels'
      : `${read.channels.length === 1 ? 'Channel' : 'Channels'} ${read.channels.join(', ')}`;
  const who = read.messages === 'people' ? "people's" : 'all';
  const dropped =
    read.dropped === 0 ? '' : ` (${read.dropped} oldest left out)`;
  return `${count} from ${channels}, ${who}${dropped}`;
}

function time(value: string | null): string {
  return value === null ? '—' : localDateTime(new Date(value));
}

function indent(text: string): string[] {
  return text.split('\n').map((line) => `  ${line}`.trimEnd());
}
