import { withoutUndefined } from '../common/without-undefined.js';
import type {
  HistoryMessages,
  WorkflowEdit,
} from '../config/workflow-input.js';
import { CliError } from './errors.js';
import { positiveInt } from './positive-int.js';

/**
 * Options of `pero workflows create` and `edit` as commander parses them:
 * `false` is the `--no-…` form, which returns a setting to its default.
 */
export interface WorkflowOptions {
  title?: string | false;
  agent?: string;
  input?: string;
  /** Parsed by the command as a positive whole number. */
  maxAttempts?: number;
  /** `--history` reads history with the defaults; `--no-history` stops. */
  history?: boolean;
  /** Parsed by the command: `all` or Channel IDs. */
  historyChannels?: 'all' | number[];
  historyMessages?: HistoryMessages;
  /** Parsed by the command as a positive whole number. */
  historyHours?: number;
  historySinceLastRun?: boolean;
  runWhenEmpty?: boolean;
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
  if (options.maxAttempts !== undefined) {
    change.maxAttempts = options.maxAttempts;
  }
  const history = historyChange(options);
  if (history !== undefined) change.history = history;
  return change;
}

/**
 * The history input the options set: null to stop reading history, the
 * fields to change (none for the defaults), or undefined when no history
 * option is given. Any history option turns history on.
 */
function historyChange(
  options: WorkflowOptions,
): WorkflowEdit['history'] | undefined {
  if (
    options.historyHours !== undefined &&
    options.historySinceLastRun === true
  ) {
    throw new CliError(
      'Give either --history-hours or --history-since-last-run, not both',
    );
  }
  const patch = withoutUndefined({
    channels: options.historyChannels,
    messages: options.historyMessages,
    hours:
      options.historyHours ?? (options.historySinceLastRun ? null : undefined),
    runWhenEmpty: options.runWhenEmpty,
  });
  if (options.history === false) {
    if (Object.keys(patch).length > 0) {
      throw new CliError(
        '--no-history stops runs reading history; give it without the other history options',
      );
    }
    return null;
  }
  if (options.history === true || Object.keys(patch).length > 0) return patch;
  return undefined;
}

/** `all`, or the comma-separated Channel IDs of `--history-channels`. */
export function parseHistoryChannels(value: string): 'all' | number[] {
  if (value.trim().toLowerCase() === 'all') return 'all';
  const ids = value.split(',').map((id) => positiveInt(id.trim()));
  if (ids.some((id) => id === null)) {
    throw new CliError(
      `--history-channels must be all or Channel IDs separated by commas, such as 3,5, not "${value}"`,
    );
  }
  return ids as number[];
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
  [/(^|; )(change\.)?maxAttempts:/g, '$1--max-attempts:'],
  [/(^|; )(change\.)?history\.channels(\.\d+)?:/g, '$1--history-channels:'],
  [/(^|; )(change\.)?history\.messages:/g, '$1--history-messages:'],
  [/(^|; )(change\.)?history\.hours:/g, '$1--history-hours:'],
  [/(^|; )(change\.)?history\.runWhenEmpty:/g, '$1--run-when-empty:'],
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
