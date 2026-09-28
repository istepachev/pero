import type { WorkflowEdit } from '../config/workflow-input.js';
import { CliError } from './errors.js';

/**
 * Options of `pero workflows create` and `edit` as commander parses them:
 * `false` is the `--no-…` form, which returns a setting to its default.
 */
export interface WorkflowOptions {
  title?: string | false;
  agent?: string;
  input?: string;
}

export interface WorkflowOptionsContext {
  /** All of standard input, for `--input -`. */
  stdin(): Promise<string>;
}

/** The Workflow fields `options` set; omitted options are left out. */
export async function workflowChange(
  options: WorkflowOptions,
  context: WorkflowOptionsContext,
): Promise<WorkflowEdit> {
  const change: WorkflowEdit = {};
  if (options.title !== undefined) {
    change.title = options.title === false ? null : options.title;
  }
  if (options.agent !== undefined) change.agent = options.agent;
  if (options.input !== undefined) {
    const text = options.input === '-' ? await context.stdin() : options.input;
    if (text.trim() === '') {
      throw new CliError(
        'No input given; --input needs the text each run sends',
      );
    }
    change.inputTemplate = text;
  }
  return change;
}

/** What `pero triggers add` sends besides the Workflow. */
export type TriggerKindChoice =
  { kind: 'schedule'; cron: string; timezone?: string } | { kind: 'manual' };

/** Options of `pero triggers add`. */
export interface TriggerOptions {
  cron?: string;
  timezone?: string;
  manual?: boolean;
}

/** The kind of Trigger `options` describe; a `CliError` unless exactly one. */
export function triggerKind(options: TriggerOptions): TriggerKindChoice {
  if (options.cron !== undefined && options.manual) {
    throw new CliError('Give either --cron or --manual, not both');
  }
  if (options.manual) {
    if (options.timezone !== undefined) {
      throw new CliError(
        '--timezone goes with --cron; a manual Trigger has none',
      );
    }
    return { kind: 'manual' };
  }
  if (options.cron === undefined) {
    throw new CliError(
      'Give a schedule with --cron "<expression>", such as --cron "0 9 * * *", or --manual',
    );
  }
  return {
    kind: 'schedule',
    cron: options.cron,
    ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
  };
}

/** Fields the daemon names in its messages, and the options that set them. */
const OPTION_NAMES: readonly [RegExp, string][] = [
  [/(^|; )(change\.)?agent:/g, '$1--agent:'],
  [/(^|; )(change\.)?inputTemplate:/g, '$1--input:'],
  [/(^|; )(change\.)?title:/g, '$1--title:'],
  [/(^|; )cron:/g, '$1--cron:'],
  [/(^|; )timezone:/g, '$1--timezone:'],
  [/(^|; )workflow:/g, '$1<workflow>:'],
  [/(^|; )name:/g, '$1<name>:'],
];

/** A daemon message about Workflow or Trigger fields, naming the options. */
export function renameWorkflowFields(message: string): string {
  return OPTION_NAMES.reduce(
    (text, [field, option]) => text.replace(field, option),
    message,
  );
}
