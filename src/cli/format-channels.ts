import type {
  ChannelDetails,
  ChannelView,
  HistoryMessage,
  UnusedNoteView,
} from '../control/protocol.js';
import {
  describeNextTurn,
  indented,
  noteErrorLines,
  noteRows,
} from './format-notes.js';
import { table } from './format-status.js';

/**
 * `pero channels ls`: one row per Channel with its note, then the Channel
 * notes none of them uses.
 */
export function formatChannelList(
  channels: readonly ChannelView[],
  unusedNotes: readonly UnusedNoteView[] = [],
): string {
  const lines =
    channels.length === 0
      ? [
          'No Channels yet. Allow a Telegram chat with pero telegram allow ' +
            '<chat-id>, then message the bot there or create a topic.',
        ]
      : table([
          ['ID', 'CHANNEL', 'TITLE', 'NOTE'],
          ...channels.map((channel) => [
            String(channel.id),
            address(channel),
            channel.title ?? '—',
            noteOf(channel),
          ]),
        ]);
  if (unusedNotes.length > 0) {
    lines.push(
      '',
      'Channel notes no Channel Pero has seen uses yet:',
      ...indented([
        ['NOTE', 'CHANNEL-ID'],
        ...unusedNotes.map((note) => [
          note.file,
          note.channelId ?? '(none: a topic of its title binds it)',
        ]),
      ]),
    );
  }
  return lines.join('\n');
}

/**
 * `pero channels show`: the Channel, the settings Pero answers there
 * with, and its next turn.
 */
export function formatChannelDetails(channel: ChannelDetails): string {
  const lines = [
    `Channel ${channel.id}${channel.title === null ? '' : ` "${channel.title}"`}`,
    ...indented([
      ['address', address(channel)],
      ...(channel.settings === null
        ? [['note', channel.note ?? 'none']]
        : noteRows(channel.settings)),
      [
        'next turn',
        channel.nextTurn === null
          ? "none: Pero doesn't answer here"
          : describeNextTurn(channel.nextTurn),
      ],
      ['history', describeHistory(channel)],
      ['created', localDateTime(new Date(channel.createdAt))],
    ]),
  ];
  if (channel.settings !== null)
    lines.push(...noteErrorLines(channel.settings));
  if (channel.folderProblem !== null) {
    lines.push('', `Warning: ${channel.folderProblem}`);
  }
  const warning = unansweredWarning(channel);
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

/** Why Pero doesn't answer in the Channel; null when it does. */
export function unansweredWarning(channel: ChannelView): string | null {
  if (channel.unanswered === null) return null;
  return `Warning: Pero doesn't answer here: ${channel.unanswered}.`;
}

/** What names a Channel in one-line messages. */
type ChannelAddress = Pick<
  ChannelView,
  'id' | 'integrationKind' | 'key' | 'title'
>;

function address(channel: ChannelAddress): string {
  return `${channel.integrationKind} ${channel.key}`;
}

function noteOf(channel: ChannelView): string {
  const note = channel.note ?? 'none yet';
  return channel.unanswered === null ? note : `${note} (not answering)`;
}

function origin(message: HistoryMessage): string {
  switch (message.origin) {
    case 'user':
      return 'user';
    case 'agent':
      return `answer ${message.agent ?? '?'}`;
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
