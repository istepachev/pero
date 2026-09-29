import { localTime, newestWithin } from './transcript.js';

/**
 * The most transcript text a fresh Session starts with; the oldest
 * messages are left out first to stay within it.
 */
export const CARRY_OVER_BUDGET = 20_000;

/** The most text of Workflow messages one turn receives before its input. */
export const POSTED_BUDGET = 20_000;

/** One earlier message as the transcript shows it. */
export interface CarriedMessage {
  /** Who wrote it, such as `User`, the Agent's name, or `Workflow <name>`. */
  speaker: string;
  text: string;
  createdAt: Date;
}

const EARLIER = {
  opening: '[Earlier conversation in this chat, from a previous session]',
  closing: '[End of earlier conversation]',
};

const POSTED = {
  opening: '[Posted in this chat by Workflows since the last message here]',
  closing: '[End of posted messages]',
};

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
  return withTranscript(input, messages, timeZone, budget, EARLIER);
}

/**
 * `input` preceded by the Workflow messages posted in the chat since the
 * last message there (oldest first), so the Agent knows what the owner may
 * be answering. Kept within `budget` like `withEarlierConversation`.
 */
export function withPostedMessages(
  input: string,
  messages: readonly CarriedMessage[],
  timeZone: string,
  budget = POSTED_BUDGET,
): string {
  return withTranscript(input, messages, timeZone, budget, POSTED);
}

function withTranscript(
  input: string,
  messages: readonly CarriedMessage[],
  timeZone: string,
  budget: number,
  marks: { opening: string; closing: string },
): string {
  const lines = newestWithin(
    messages.map(
      (message) =>
        `${localTime(message.createdAt, timeZone)} ${message.speaker}: ${message.text}`,
    ),
    budget,
  );
  if (lines.length === 0) return input;
  return [marks.opening, ...lines, marks.closing, '', input].join('\n');
}
