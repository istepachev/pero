import { formatDuration } from '../../cli/format-status.js';
import type { AgentView, ComponentStatus } from '../../control/protocol.js';
import { localTime } from '../../history/transcript.js';
import type { ValueOrigin } from '../../settings-files/origins.js';
import type { ButtonRows, OutboundButton } from '../channel-adapter.js';
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

const STATUS: OutboundButton = { id: '/status', label: 'Status' };
const BACK: OutboundButton = { id: '/status', label: '« Back' };
const NEW: OutboundButton = { id: '/new ask', label: 'New session' };
const STOP: OutboundButton = { id: '/stop', label: 'Stop' };

/** `/help`: each command with its line, and buttons for the common ones. */
export function helpScreen(): Screen {
  return {
    text: [
      'Pero answers these commands itself; anything else goes to the Agent.',
      '',
      ...COMMANDS.map(({ name, description }) => `/${name} — ${description}`),
    ].join('\n'),
    buttons: [[STATUS, NEW, STOP]],
  };
}

/** The Session a Channel's Agent answers in, as `/status` shows it. */
export interface SessionStatus {
  id: number;
  createdAt: Date;
  /** How many of the person's messages it has answered or is answering. */
  turns: number;
  contextTokens: number | null;
  contextWindow: number | null;
}

/** What `/status` shows about the Agent that answers in a Channel. */
export interface AgentStatus {
  agent: Pick<
    AgentView,
    | 'name'
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
  /** The Agent that answers there; null when no one does. */
  agent: AgentStatus | null;
  /** Why no one answers, and what to edit; null when an Agent does. */
  unanswered: string | null;
  components: readonly ComponentStatus[];
  timezone: string;
  now: Date;
}

/** `/status`: the Channel's Agent, then a line about Pero itself. */
export function statusScreen(input: StatusInput): Screen {
  const lines =
    input.agent === null
      ? [input.unanswered ?? 'No Agent answers here.']
      : agentLines(input, input.agent);
  lines.push('', peroLine(input.components));
  const status = input.agent;
  if (status === null) return { text: lines.join('\n'), buttons: [[STATUS]] };
  return {
    text: lines.join('\n'),
    buttons: [
      status.runningSince === null && status.queued === 0
        ? [NEW, { id: '/status', label: 'Refresh' }]
        : [STOP, NEW, { id: '/status', label: 'Refresh' }],
    ],
  };
}

function agentLines(input: StatusInput, status: AgentStatus): string[] {
  const { agent, session } = status;
  const { origins } = agent;
  const lines = [
    `Agent ${agent.name}${input.where === null ? '' : ` · ${input.where}`}`,
    `State: ${state(status, input)}`,
    `Config: ${agent.file}`,
    `Provider: ${agent.provider}${from(origins.provider)} · ` +
      `${option('model', agent.model, origins.model)} · ` +
      `${option('effort', agent.effort, origins.effort)}`,
    `Permissions: ${agent.permissions}${from(origins.permissions)}`,
    `Folder: ${status.folder}`,
    `Session: ${sessionLine(status, input.timezone)}`,
  ];
  if (session?.contextTokens != null) {
    lines.push(
      `Context: ${context(session.contextTokens, session.contextWindow)}`,
    );
  }
  if (agent.errors.length > 0) {
    lines.push(
      'Note errors, so its last good version is in use:',
      ...agent.errors.map(
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

function state(status: AgentStatus, input: StatusInput): string {
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

function sessionLine(status: AgentStatus, timezone: string): string {
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
export function newConfirmScreen(agent: string): Screen {
  return {
    text:
      `Start over with Agent ${agent} here? Its next answer begins a new ` +
      `conversation, without what was said so far. The history is kept.`,
    buttons: [
      [
        { id: '/new yes', label: 'Yes, start over' },
        { id: '/status', label: 'Cancel' },
      ],
    ],
  };
}

/** What `/new` did; `by` names who pressed its button. */
export function newDoneScreen(
  agent: string,
  stopped: boolean,
  by: string | null,
): Screen {
  return {
    text: [
      `Started over: Agent ${agent}'s next answer here begins a new ` +
        `conversation.` +
        (stopped ? ' Its answer in progress was stopped.' : ''),
      ...byLine(by),
    ].join('\n'),
    ...(by === null ? {} : { buttons: [[BACK]] }),
  };
}

/** What `/stop` did; `by` names who pressed its button. */
export function stopScreen(
  agent: string | null,
  result: { stopped: boolean; dropped: number },
  by: string | null,
): Screen {
  const who = agent === null ? 'The Agent' : `Agent ${agent}`;
  const whose = agent === null ? 'the' : `Agent ${agent}'s`;
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

/** A command that needs an Agent where none answers: why, and the fix. */
export function noAgentScreen(unanswered: string): Screen {
  return { text: unanswered, buttons: [[STATUS]] };
}

function byLine(by: string | null): string[] {
  return by === null ? [] : [`— ${by}`];
}
