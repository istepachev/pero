import { localTime, newestWithin } from './transcript.js';

/**
 * The most transcript text a fresh Session starts with; the oldest
 * messages are left out first to stay within it.
 */
export const CARRY_OVER_BUDGET = 20_000;

/** One earlier message as the transcript shows it. */
export interface CarriedMessage {
  /** Who wrote it, such as `User` or the Agent's name. */
  speaker: string;
  text: string;
  createdAt: Date;
}

const OPENING = '[Earlier conversation in this chat, from a previous session]';
const CLOSING = '[End of earlier conversation]';

/**
 * `input` preceded by `messages` (oldest first) as a transcript marked as
 * earlier conversation, with times in `timeZone`. The newest messages that
 * fit in `budget` characters are kept; one that alone is too long is cut.
 */
export function withEarlierConversation(
  input: string,
  messages: readonly CarriedMessage[],
  timeZone: string,
  budget = CARRY_OVER_BUDGET,
): string {
  const lines = newestWithin(
    messages.map(
      (message) =>
        `${localTime(message.createdAt, timeZone)} ${message.speaker}: ${message.text}`,
    ),
    budget,
  );
  if (lines.length === 0) return input;
  return [OPENING, ...lines, CLOSING, '', input].join('\n');
}
