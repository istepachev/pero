import { localTime, newestWithin } from './transcript.js';

/**
 * The most transcript text a Workflow Run's input carries; the oldest
 * messages are left out first to stay within it.
 */
export const HISTORY_INPUT_BUDGET = 50_000;

/** Where an input template takes the transcript. */
export const HISTORY_PLACEHOLDER = '{{history}}';

/** One message of a history window as the transcript shows it. */
export interface WindowMessage {
  /** The Channel's title, or its key when it has none. */
  channel: string;
  /** Who wrote it, such as `User` or `Pero`. */
  speaker: string;
  text: string;
  createdAt: Date;
}

const OPENING = '[Chat history]';
const CLOSING = '[End of chat history]';
const EMPTY = '[No messages in this window]';

/**
 * `template` with `messages` (oldest first) as a transcript in `timeZone`,
 * in place of `{{history}}`, or after the input when there is none. The
 * newest messages that fit in `budget` characters are kept, and the
 * transcript says how many older ones it left out.
 */
export function renderHistoryInput(
  template: string,
  messages: readonly WindowMessage[],
  timeZone: string,
  budget = HISTORY_INPUT_BUDGET,
): { input: string; dropped: number } {
  const lines = newestWithin(
    messages.map(
      (message) =>
        `${localTime(message.createdAt, timeZone)} [${message.channel}] ${message.speaker}: ${message.text}`,
    ),
    budget,
  );
  const dropped = messages.length - lines.length;
  const transcript =
    messages.length === 0
      ? EMPTY
      : [
          OPENING,
          ...(dropped === 0
            ? []
            : [
                `[${dropped} earlier ${dropped === 1 ? 'message' : 'messages'} left out to fit]`,
              ]),
          ...lines,
          CLOSING,
        ].join('\n');
  const input = template.includes(HISTORY_PLACEHOLDER)
    ? template.replaceAll(HISTORY_PLACEHOLDER, () => transcript)
    : `${template}\n\n${transcript}`;
  return { input, dropped };
}
