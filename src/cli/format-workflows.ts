import type {
  RunView,
  WorkflowChannelView,
  WorkflowScheduleView,
  WorkflowView,
} from '../control/protocol.js';
import { localDateTime } from './format-channels.js';
import { table } from './format-status.js';
import { preview } from './preview.js';

/** `pero workflows ls`: one row per Workflow. */
export function formatWorkflowList(workflows: readonly WorkflowView[]): string {
  if (workflows.length === 0) {
    return 'No Workflows yet. Add a note to the Workflows folder in the settings folder.';
  }
  const lines = table([
    ['NAME', 'AGENT', 'SCHEDULE', 'NEXT RUN', 'CHANNELS', 'STATE', 'NOTE'],
    ...workflows.map((workflow) => [
      `${workflow.name}${workflow.errors.length > 0 ? ' !' : ''}`,
      agent(workflow),
      workflow.schedules.map(schedule).join('; ') || 'by hand',
      workflow.schedules.map((one) => nextRun(workflow, one)).join('; ') || '—',
      workflow.channels.map(channelLabel).join(', ') || '—',
      state(workflow.enabled),
      workflow.file,
    ]),
  ]);
  if (workflows.some((workflow) => workflow.errors.length > 0)) {
    lines.push(
      '',
      '! its note has errors, so its last good version is in use; pero check lists them',
    );
  }
  return lines.join('\n');
}

/** `pero workflows show`: the definition, then the Channels it posts to. */
export function formatWorkflowDetails(workflow: WorkflowView): string {
  const lines = [
    `Workflow ${workflow.name}${workflow.title === null ? '' : ` "${workflow.title}"`}`,
    ...table([
      ['note', workflow.file],
      ['agent', agent(workflow)],
      ['input', preview(workflow.inputTemplate)],
      ...(workflow.schedules.length === 0
        ? [['schedule', 'none: it runs by hand, with pero workflows run']]
        : workflow.schedules.flatMap((one) => [
            ['schedule', schedule(one)],
            ['next run', nextRun(workflow, one)],
            [
              'last run',
              one.lastRunAt === null
                ? 'never'
                : localDateTime(new Date(one.lastRunAt)),
            ],
          ])),
      ['runs', 'one at a time'],
      ['attempts', attempts(workflow.maxAttempts)],
      ['history', history(workflow.history)],
      [
        'state',
        workflow.enabled
          ? 'enabled'
          : 'disabled: it runs only by hand, with pero workflows run',
      ],
    ]).map((row) => `  ${row}`),
  ];
  if (workflow.errors.length > 0) {
    lines.push(
      '',
      'Its note has errors, so its last good version is in use:',
      ...workflow.errors.map(
        ({ property, message }) =>
          `  ${property === null ? '' : `${property}: `}${message}`,
      ),
    );
  }
  const warning = agentWarning(workflow);
  if (warning !== null) lines.push('', warning);
  lines.push('');
  if (workflow.channels.length === 0) {
    lines.push(
      'Posts to no Channel: name a topic in channel in its note to post its answers there.',
    );
  } else {
    lines.push(
      'Posts to',
      ...table([
        ['ID', 'CHANNEL', 'TITLE'],
        ...workflow.channels.map((channel) => [
          String(channel.id),
          `${channel.integrationKind} ${channel.key}`,
          channel.title ?? '—',
        ]),
      ]).map((row) => `  ${row}`),
    );
  }
  return lines.join('\n');
}

/**
 * What a finished run leaves the owner: the Agent's answer, or why there
 * is none.
 */
export function runOutcome(run: RunView): { ok: boolean; text: string } {
  if (run.status === 'completed') {
    return {
      ok: true,
      text: run.skipped
        ? `Run ${run.id} of Workflow ${run.workflow} skipped: no messages in its history window`
        : (run.result ?? ''),
    };
  }
  return {
    ok: false,
    text:
      `Run ${run.id} of Workflow ${run.workflow} ${run.status}: ` +
      (run.error ?? 'no reason was recorded'),
  };
}

/** How a Workflow treats a run Pero stopped before it finished. */
function attempts(maxAttempts: number): string {
  return maxAttempts === 1
    ? '1 (a run Pero stops is not started again)'
    : `up to ${maxAttempts} (a run Pero stops starts again when Pero does)`;
}

/**
 * The Channel history a Workflow's runs read, such as `people's messages
 * in Channels 3, 5 since the previous run; skipped when there are none`.
 */
function history(config: WorkflowView['history']): string {
  if (config === null) return 'none';
  const messages =
    config.messages === 'people' ? "people's messages" : 'all messages';
  const channels =
    config.channels === 'all'
      ? 'all Channels'
      : config.channels.map(channelLabel).join(', ');
  const window =
    config.hours === null
      ? 'since the previous run'
      : `from the last ${config.hours === 1 ? 'hour' : `${config.hours} hours`}`;
  const empty = config.runWhenEmpty
    ? 'runs even when there are none'
    : 'skipped when there are none';
  return `${messages} in ${channels} ${window}; ${empty}`;
}

/** Why the Workflow cannot run; null when it can. */
export function agentWarning(workflow: WorkflowView): string | null {
  if (workflow.agentEnabled) return null;
  return (
    `Warning: Agent ${workflow.agent} is disabled or has no note, so this ` +
    'Workflow cannot run until it is enabled again (enabled: true in its note).'
  );
}

/** `0 12 * * 0 (Europe/Berlin)`. */
function schedule(one: WorkflowScheduleView): string {
  return `${one.cron} (${one.timezone})`;
}

function nextRun(workflow: WorkflowView, one: WorkflowScheduleView): string {
  if (!workflow.enabled) return '—';
  return one.nextRunAt === null
    ? 'none'
    : localDateTime(new Date(one.nextRunAt));
}

/** A topic by its title, or a Channel without one by its ID. */
function channelLabel(channel: WorkflowChannelView): string {
  return channel.title ?? `Channel ${channel.id}`;
}

function agent(workflow: WorkflowView): string {
  return workflow.agentEnabled
    ? workflow.agent
    : `${workflow.agent} (disabled)`;
}

function state(enabled: boolean): string {
  return enabled ? 'enabled' : 'disabled';
}
