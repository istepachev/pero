import type {
  ChannelDetails,
  ChannelView,
  HistoryMessage,
} from '../control/protocol.js';
import { describeNextTurn } from './format-agents.js';
import { table } from './format-status.js';

/** `pero channels ls`: one row per Channel. */
export function formatChannelList(channels: readonly ChannelView[]): string {
  if (channels.length === 0) {
    return (
      'No Channels yet. Allow a Telegram chat with pero telegram allow ' +
      '<chat-id>, then message the bot there or create a topic.'
    );
  }
  return table([
    ['ID', 'CHANNEL', 'TITLE', 'AGENT', 'STATE'],
    ...channels.map((channel) => [
      String(channel.id),
      address(channel),
      channel.title ?? '—',
      agent(channel),
      state(channel),
    ]),
  ]).join('\n');
}

/** `pero channels show`: the Channel, its Agent, and its next turn. */
export function formatChannelDetails(channel: ChannelDetails): string {
  const lines = [
    `Channel ${channel.id}${channel.title === null ? '' : ` "${channel.title}"`}`,
    ...table([
      ['address', address(channel)],
      ['agent', agent(channel)],
      ['state', state(channel)],
      [
        'next turn',
        channel.nextTurn === null
          ? 'none: no note defines its Agent'
          : describeNextTurn(channel.nextTurn),
      ],
      ['history', describeHistory(channel)],
      ['created', localDateTime(new Date(channel.createdAt))],
    ]).map((row) => `  ${row}`),
  ];
  const warning = agentWarning(channel);
  if (warning !== null) lines.push('', warning);
  return lines.join('\n');
}

/** `pero channels assign`: who answers now, and what the next turn does. */
export function formatAssigned(
  channel: ChannelDetails,
  alreadyAssigned: boolean,
): string {
  if (alreadyAssigned) {
    return `${describeChannel(channel)} already talks to Agent ${channel.agent}.`;
  }
  // Assignment closes the Channel's Session, so the next turn starts one.
  const carried = channel.nextTurn?.carriesOver
    ? ", with the Channel's recent messages"
    : '';
  const lines = [
    `${describeChannel(channel)} now talks to Agent ${channel.agent}.`,
    `Its next turn starts a fresh Session${carried}.`,
  ];
  if (!channel.enabled) {
    lines.push(
      `It is disabled, so it gets no answer until pero channels enable ${channel.id}.`,
    );
  }
  return lines.join('\n');
}

/** `pero channels history`: the messages, oldest first. */
export function formatHistory(
  channel: ChannelView,
  messages: readonly HistoryMessage[],
): string {
  if (messages.length === 0) {
    return `No messages yet in ${describeChannel(channel)}.`;
  }
  const rows = messages.map((message) => [
    localDateTime(new Date(message.createdAt)),
    message.direction,
    origin(message),
  ]);
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => row[column]!.length)),
  );
  const indent = widths.reduce((sum, width) => sum + width + 2, 0);
  return messages
    .map((message, index) => {
      const head = rows[index]!.map((cell, column) =>
        cell.padEnd(widths[column]!),
      ).join('  ');
      const [first = '', ...rest] = message.text.split('\n');
      return [
        `${head}  ${first}`.trimEnd(),
        ...rest.map((line) => `${' '.repeat(indent)}${line}`.trimEnd()),
      ].join('\n');
    })
    .join('\n');
}

/** `Channel 2 (telegram -100…:42 "Groceries")`, for one-line messages. */
export function describeChannel(channel: ChannelAddress): string {
  const title = channel.title === null ? '' : ` "${channel.title}"`;
  return `Channel ${channel.id} (${address(channel)}${title})`;
}

/** Why the Channel gets no answer from its Agent; null when it does. */
export function agentWarning(channel: ChannelView): string | null {
  if (!channel.agentDefined) {
    return (
      `Warning: Agent ${channel.agent} has no note, so this Channel gets no ` +
      `answer until Agents/${channel.agent}.md is added to the settings folder.`
    );
  }
  if (channel.agentEnabled) return null;
  return (
    `Warning: Agent ${channel.agent} is disabled, so this Channel gets no ` +
    `answer until it is enabled again (enabled: true in its note).`
  );
}

/** What names a Channel in one-line messages. */
type ChannelAddress = Pick<
  ChannelView,
  'id' | 'integrationKind' | 'key' | 'title'
>;

function address(channel: ChannelAddress): string {
  return `${channel.integrationKind} ${channel.key}`;
}

function agent(channel: ChannelView): string {
  if (!channel.agentDefined) return `${channel.agent} (no note)`;
  return channel.agentEnabled ? channel.agent : `${channel.agent} (disabled)`;
}

function state(channel: ChannelView): string {
  return channel.enabled ? 'enabled' : 'disabled';
}

function origin(message: HistoryMessage): string {
  switch (message.origin) {
    case 'user':
      return 'user';
    case 'agent':
      return `agent ${message.agent ?? '?'}`;
    case 'pero':
      return 'pero';
    case 'workflow':
      return `workflow ${message.workflow ?? '?'}`;
  }
}

function describeHistory(channel: ChannelDetails): string {
  if (channel.lastMessageAt === null) return 'no messages yet';
  const count =
    channel.messages === 1 ? '1 message' : `${channel.messages} messages`;
  return `${count}, the latest at ${localDateTime(new Date(channel.lastMessageAt))}`;
}

/** `2026-09-28 14:03` in the local time zone. */
export function localDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
