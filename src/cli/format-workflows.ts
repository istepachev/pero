import type {
  RunView,
  TriggerView,
  WorkflowDetails,
  WorkflowView,
} from '../control/protocol.js';
import { describeChannel, localDateTime } from './format-channels.js';
import { table } from './format-status.js';
import { preview } from './settings-keys.js';

/** `pero workflows ls`: one row per Workflow. */
export function formatWorkflowList(workflows: readonly WorkflowView[]): string {
  if (workflows.length === 0) {
    return (
      'No Workflows yet. Create one with pero workflows create <name> ' +
      '--agent <agent> --input <text>.'
    );
  }
  return table([
    ['NAME', 'AGENT', 'TRIGGERS', 'STATE'],
    ...workflows.map((workflow) => [
      workflow.name,
      agent(workflow),
      String(workflow.triggerCount),
      state(workflow.enabled),
    ]),
  ]).join('\n');
}

/** `pero workflows show`: the definition, then its Triggers. */
export function formatWorkflowDetails(workflow: WorkflowDetails): string {
  const lines = [
    `Workflow ${workflow.name}${workflow.title === null ? '' : ` "${workflow.title}"`}`,
    ...table([
      ['agent', agent(workflow)],
      ['input', preview(workflow.inputTemplate)],
      ['runs', 'one at a time'],
      ['attempts', attempts(workflow.maxAttempts)],
      ['history', history(workflow.history)],
      ['state', state(workflow.enabled)],
    ]).map((row) => `  ${row}`),
  ];
  const warning = agentWarning(workflow);
  if (warning !== null) lines.push('', warning);
  lines.push('');
  if (workflow.triggers.length === 0) {
    lines.push(
      `No Trigger yet: pero triggers add ${workflow.name} --cron "<expression>" or --manual.`,
    );
  } else {
    lines.push(
      'Triggers',
      ...triggerTable(workflow.triggers, false).map((row) => `  ${row}`),
    );
  }
  lines.push('');
  if (workflow.targets.length === 0) {
    lines.push(
      `Notifies no Channel: pero workflows notify ${workflow.name} <channel> posts its answers there.`,
    );
  } else {
    lines.push(
      'Notifies',
      ...table([
        ['ID', 'CHANNEL', 'TITLE', 'STATE'],
        ...workflow.targets.map((target) => [
          String(target.id),
          `${target.integrationKind} ${target.key}`,
          target.title ?? '—',
          state(target.enabled),
        ]),
      ]).map((row) => `  ${row}`),
    );
  }
  return lines.join('\n');
}

/** `pero workflows notify`: what changed, and what the Channel now gets. */
export function formatNotify(
  workflow: WorkflowDetails,
  channelId: number,
  notify: boolean,
  changed: boolean,
): string {
  const target = workflow.targets.find(({ id }) => id === channelId);
  const channel =
    target === undefined ? `Channel ${channelId}` : describeChannel(target);
  if (!notify) {
    return changed
      ? `Workflow ${workflow.name} no longer notifies ${channel}.`
      : `Workflow ${workflow.name} did not notify ${channel}.`;
  }
  const lines = [
    changed
      ? `Workflow ${workflow.name} now notifies ${channel}: each answer, and each run that fails, is posted there.`
      : `Workflow ${workflow.name} already notifies ${channel}.`,
  ];
  if (target !== undefined && !target.enabled) {
    lines.push(
      `Note: ${channel} is disabled, so its Agent does not answer there; pero channels enable ${channelId} turns it back on.`,
    );
  }
  return lines.join('\n');
}

/** `pero triggers ls`: one row per Trigger. */
export function formatTriggerList(triggers: readonly TriggerView[]): string {
  if (triggers.length === 0) {
    return (
      'No Triggers yet. Add one with pero triggers add <workflow> ' +
      '--cron "0 9 * * *" or --manual.'
    );
  }
  return triggerTable(triggers, true).join('\n');
}

/** `Trigger 3 of daily-brief (0 9 * * * Europe/Berlin)`, for one-liners. */
export function describeTrigger(trigger: TriggerView): string {
  return `Trigger ${trigger.id} of ${trigger.workflow} (${schedule(trigger)})`;
}

/**
 * `Trigger 3 of daily-brief (0 9 * * * Europe/Berlin), next run 2026-09-29
 * 09:00`, for a schedule that has one.
 */
export function describeScheduledTrigger(trigger: TriggerView): string {
  const described = describeTrigger(trigger);
  return trigger.kind === 'schedule' && trigger.nextRunAt !== null
    ? `${described}, next run ${localDateTime(new Date(trigger.nextRunAt))}`
    : described;
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
      : `${config.channels.length === 1 ? 'Channel' : 'Channels'} ${config.channels.join(', ')}`;
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
    `Warning: Agent ${workflow.agent} is disabled, so this Workflow cannot ` +
    `run until pero agents enable ${workflow.agent}.`
  );
}

function triggerTable(
  triggers: readonly TriggerView[],
  withWorkflow: boolean,
): string[] {
  return table([
    [
      'ID',
      ...(withWorkflow ? ['WORKFLOW'] : []),
      'SCHEDULE',
      'NEXT RUN',
      'STATE',
    ],
    ...triggers.map((trigger) => [
      String(trigger.id),
      ...(withWorkflow ? [trigger.workflow] : []),
      schedule(trigger),
      nextRun(trigger),
      state(trigger.enabled),
    ]),
  ]);
}

function schedule(trigger: TriggerView): string {
  return trigger.kind === 'schedule'
    ? `${trigger.cron} ${trigger.timezone}`
    : 'manual';
}

function nextRun(trigger: TriggerView): string {
  if (trigger.kind !== 'schedule' || !trigger.enabled) return '—';
  return trigger.nextRunAt === null
    ? 'none'
    : localDateTime(new Date(trigger.nextRunAt));
}

function agent(workflow: WorkflowView): string {
  return workflow.agentEnabled
    ? workflow.agent
    : `${workflow.agent} (disabled)`;
}

function state(enabled: boolean): string {
  return enabled ? 'enabled' : 'disabled';
}
