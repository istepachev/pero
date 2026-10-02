import { formatDuration } from '../../cli/format-status.js';
import type {
  ChannelNoteView,
  ComponentStatus,
} from '../../control/protocol.js';
import { localTime } from '../../history/transcript.js';
import type { ValueOrigin } from '../../system-files/origins.js';
import {
  type ButtonRows,
  MAX_BUTTON_ID_BYTES,
  type OutboundButton,
} from '../channel-adapter.js';
import { COMMANDS } from './command-list.js';

/*
 * What each command answers, as text with buttons. Pure, so every screen is
 * tested without a bot. A button's ID is the command it runs.
 */

/** A command's answer: a new message when typed, an edit when pressed. */
export interface Screen {
  text: string;
  buttons?: ButtonRows;
}

/** A command's answer, and the notice for whoever pressed its button. */
export interface Answer {
  screen: Screen;
  notice: string | null;
}

const STATUS: OutboundButton = { id: '/status', label: 'Status' };
const BACK: OutboundButton = { id: '/status', label: '« Back' };
const NEW: OutboundButton = { id: '/new ask', label: 'New session' };
const STOP: OutboundButton = { id: '/stop', label: 'Stop' };
const MODEL: OutboundButton = { id: '/model', label: 'Model' };
const EFFORT: OutboundButton = { id: '/effort', label: 'Effort' };
const WORKFLOWS: OutboundButton = { id: '/workflows', label: 'Workflows' };

/** `/help`: each command with its line, and buttons for the common ones. */
export function helpScreen(): Screen {
  return {
    text: [
      'Pero answers these commands itself; anything else is a message to answer.',
      '',
      ...COMMANDS.map(({ name, description }) => `/${name} — ${description}`),
    ].join('\n'),
    buttons: [
      [STATUS, NEW, STOP],
      [MODEL, EFFORT, WORKFLOWS],
    ],
  };
}

/** The Session Pero answers in in a Channel, as `/status` shows it. */
export interface SessionStatus {
  id: number;
  createdAt: Date;
  /** How many of the person's messages it has answered or is answering. */
  turns: number;
  contextTokens: number | null;
  contextWindow: number | null;
}

/** What `/status` shows about how Pero answers in a Channel. */
export interface ChannelStatus {
  note: Pick<
    ChannelNoteView,
    | 'title'
    | 'file'
    | 'provider'
    | 'model'
    | 'effort'
    | 'permissions'
    | 'origins'
    | 'errors'
  >;
  /** The folder its turns run in, as the owner knows it. */
  folder: string;
  folderProblem: string | null;
  /** When its running turn started; null when it is idle. */
  runningSince: Date | null;
  queued: number;
  lastAnswerAt: Date | null;
  /** The active Session; null when the next message starts one. */
  session: SessionStatus | null;
  /** Whether `/new` marked where the next Session starts. */
  startedOver: boolean;
}

export interface StatusInput {
  /** The Channel's name: a topic's title, a group's, or a person's. */
  where: string | null;
  /** How Pero answers there; null when it doesn't. */
  channel: ChannelStatus | null;
  /** Why Pero doesn't answer, and what to edit; null when it does. */
  unanswered: string | null;
  components: readonly ComponentStatus[];
  timezone: string;
  now: Date;
}

/** `/status`: how Pero answers in the Channel, then a line about Pero. */
export function statusScreen(input: StatusInput): Screen {
  const lines =
    input.channel === null
      ? [input.unanswered ?? "Pero doesn't answer here."]
      : channelLines(input, input.channel);
  lines.push('', peroLine(input.components));
  const status = input.channel;
  if (status === null) return { text: lines.join('\n'), buttons: [[STATUS]] };
  return {
    text: lines.join('\n'),
    buttons: [
      status.runningSince === null && status.queued === 0
        ? [NEW, { id: '/status', label: 'Refresh' }]
        : [STOP, NEW, { id: '/status', label: 'Refresh' }],
      [MODEL, EFFORT],
    ],
  };
}

function channelLines(input: StatusInput, status: ChannelStatus): string[] {
  const { note, session } = status;
  const { origins } = note;
  const lines = [
    `Channel ${input.where ?? note.title}`,
    `State: ${state(status, input)}`,
    `Config: ${note.file ?? '(no note yet)'}`,
    `Provider: ${note.provider}${from(origins.provider)} · ` +
      `${option('model', note.model, origins.model)} · ` +
      `${option('effort', note.effort, origins.effort)}`,
    `Permissions: ${note.permissions}${from(origins.permissions)}`,
    `Folder: ${status.folder}`,
    `Session: ${sessionLine(status, input.timezone)}`,
  ];
  if (session?.contextTokens != null) {
    lines.push(
      `Context: ${context(session.contextTokens, session.contextWindow)}`,
    );
  }
  if (note.errors.length > 0) {
    lines.push(
      'Note errors, so its last good version is in use:',
      ...note.errors.map(
        ({ property, message }) =>
          `  ${property === null ? '' : `${property}: `}${message}`,
      ),
    );
  }
  if (status.folderProblem !== null) {
    lines.push(`Warning: ${status.folderProblem}`);
  }
  return lines;
}

function state(status: ChannelStatus, input: StatusInput): string {
  const queued = status.queued > 0 ? ` · ${status.queued} queued` : '';
  if (status.runningSince !== null) {
    const ms = input.now.getTime() - status.runningSince.getTime();
    return `answering for ${formatDuration(Math.max(0, ms))}${queued}`;
  }
  if (status.queued > 0) return `about to answer${queued}`;
  return status.lastAnswerAt === null
    ? 'idle'
    : `idle · last answer ${localTime(status.lastAnswerAt, input.timezone)}`;
}

function sessionLine(status: ChannelStatus, timezone: string): string {
  const { session } = status;
  if (session === null) {
    return status.startedOver
      ? 'none: the next message starts a new one, after /new'
      : 'none yet: the next message starts one';
  }
  const turns = `${session.turns} turn${session.turns === 1 ? '' : 's'}`;
  return `#${session.id} since ${localTime(session.createdAt, timezone)} · ${turns}`;
}

/** `~84k of 200k tokens (42%)`, or `~84k tokens` without a window. */
export function context(tokens: number, window: number | null): string {
  if (window === null || window <= 0) return `~${kilo(tokens)} tokens`;
  const percent = Math.round((tokens / window) * 100);
  return `~${kilo(tokens)} of ${kilo(window)} tokens (${percent}%)`;
}

/** Tokens in thousands, such as `84k`, or `1.2M` past a million. */
function kilo(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  }
  return tokens < 1_000 ? String(tokens) : `${Math.round(tokens / 1_000)}k`;
}

function from(origin: ValueOrigin): string {
  return origin === 'pero'
    ? ' (Pero.md)'
    : origin === 'default'
      ? ' (default)'
      : '';
}

function option(
  name: string,
  value: string | null,
  origin: ValueOrigin,
): string {
  return value === null ? `default ${name}` : `${name} ${value}${from(origin)}`;
}

/** Each component of Pero and its state, on one line. */
function peroLine(components: readonly ComponentStatus[]): string {
  return `Pero: ${components
    .map(({ name, state }) => `${name} ${state}`)
    .join(' · ')}`;
}

/** `/new` from a button: confirm first, since the conversation goes. */
export function newConfirmScreen(): Screen {
  return {
    text:
      `Start over here? Pero's next answer begins a new conversation, ` +
      `without what was said so far. The history is kept.`,
    buttons: [
      [
        { id: '/new yes', label: 'Yes, start over' },
        { id: '/status', label: 'Cancel' },
      ],
    ],
  };
}

/** What `/new` did; `by` names who pressed its button. */
export function newDoneScreen(stopped: boolean, by: string | null): Screen {
  return {
    text: [
      `Started over: Pero's next answer here begins a new conversation.` +
        (stopped ? ' Its answer in progress was stopped.' : ''),
      ...byLine(by),
    ].join('\n'),
    ...(by === null ? {} : { buttons: [[BACK]] }),
  };
}

/** What `/stop` did; `by` names who pressed its button. */
export function stopScreen(
  result: { stopped: boolean; dropped: number },
  by: string | null,
): Screen {
  const who = 'Pero';
  const whose = "Pero's";
  let text: string;
  if (!result.stopped && result.dropped === 0) {
    text = `${who} isn't answering anything here.`;
  } else {
    const dropped =
      result.dropped === 0
        ? ''
        : ` ${result.dropped} waiting message${result.dropped === 1 ? '' : 's'} won't be answered.`;
    text = result.stopped
      ? `Stopped ${whose} answer.${dropped}`
      : `${who} hadn't started answering.${dropped}`;
  }
  return {
    text: [text, ...byLine(by)].join('\n'),
    ...(by === null ? {} : { buttons: [[BACK]] }),
  };
}

/** A setting `/model` and `/effort` show and change. */
export type NoteOption = 'model' | 'effort';

/** One of a Channel's settings, and what it may be set to. */
export interface OptionStatus {
  /** Its note, as `/status` shows it; null while it has none. */
  file: string | null;
  option: NoteOption;
  /** What the Channel uses now; null lets the provider choose. */
  value: string | null;
  origin: ValueOrigin;
  /** `Pero.md`'s value for the Channel's provider; null when it sets none. */
  peroDefault: string | null;
  /** The values offered as buttons. */
  choices: readonly string[];
}

/** How many choices fit on one row of buttons. */
const PER_ROW = 3;

/**
 * `/model` or `/effort` without a value, or with one that can't be used,
 * which `problem` explains: the value, and a button for each choice.
 */
export function optionScreen(
  status: OptionStatus,
  problem: string | null = null,
): Screen {
  const { option: setting, value, origin } = status;
  const choices = status.choices.filter((choice) =>
    buttonFits(`/${setting} ${choice}`),
  );
  const rows: OutboundButton[][] = [];
  for (let at = 0; at < choices.length; at += PER_ROW) {
    rows.push(
      choices.slice(at, at + PER_ROW).map((choice) => ({
        id: `/${setting} ${choice}`,
        label: origin === 'note' && choice === value ? `✓ ${choice}` : choice,
      })),
    );
  }
  const fallback =
    status.peroDefault === null
      ? "provider's"
      : `Pero.md: ${status.peroDefault}`;
  rows.push([
    {
      id: `/${setting} default`,
      label: `${origin === 'note' ? '' : '✓ '}Default (${fallback})`,
    },
  ]);
  rows.push([BACK]);
  return {
    text: [
      ...(problem === null ? [] : [problem]),
      `This Channel uses ${option(setting, value, origin)}.`,
      setting === 'model'
        ? 'Pick one, or send /model <name> for any other. It applies from the next answer.'
        : 'Pick one. It applies from the next answer.',
    ].join('\n'),
    buttons: rows,
  };
}

/** What `/model` or `/effort` changed; `by` names who pressed its button. */
export function optionSetScreen(
  status: Pick<OptionStatus, 'file' | 'option' | 'value' | 'origin'>,
  changed: boolean,
  by: string | null,
): Screen {
  const now = option(status.option, status.value, status.origin);
  return {
    text: [
      changed
        ? `This Channel now uses ${now}, from the next answer.`
        : `This Channel already uses ${now}.`,
      `Config: ${status.file ?? '(no note yet)'}`,
      ...byLine(changed ? by : null),
    ].join('\n'),
    buttons: [
      [
        { id: `/${status.option}`, label: `« ${capitalized(status.option)}` },
        BACK,
      ],
    ],
  };
}

function capitalized(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

function buttonFits(id: string): boolean {
  return Buffer.byteLength(id) <= MAX_BUTTON_ID_BYTES;
}

/** A command that needs Pero to answer where it doesn't: why, and the fix. */
export function unansweredScreen(unanswered: string): Screen {
  return { text: unanswered, buttons: [[STATUS]] };
}

function byLine(by: string | null): string[] {
  return by === null ? [] : [`— ${by}`];
}
