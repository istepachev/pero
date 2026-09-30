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
    ['ID', 'CHANNEL', 'TITLE', 'AGENT'],
    ...channels.map((channel) => [
      String(channel.id),
      address(channel),
      channel.title ?? '—',
      agent(channel),
    ]),
  ]).join('\n');
}

/** `pero channels show`: the Channel, who answers there, and its next turn. */
export function formatChannelDetails(channel: ChannelDetails): string {
  const lines = [
    `Channel ${channel.id}${channel.title === null ? '' : ` "${channel.title}"`}`,
    ...table([
      ['address', address(channel)],
      ['agent', agent(channel)],
      [
        'next turn',
        channel.nextTurn === null
          ? 'none: no one answers here'
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

/** Why no one answers in the Channel; null when an Agent does. */
export function agentWarning(channel: ChannelView): string | null {
  if (channel.unanswered === null) return null;
  return `Warning: no one answers here: ${channel.unanswered}.`;
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
  if (channel.agent === null) return 'none';
  return channel.agentEnabled ? channel.agent : `${channel.agent} (disabled)`;
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
