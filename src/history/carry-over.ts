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
  const lines: string[] = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    const line = `${localTime(message.createdAt, timeZone)} ${message.speaker}: ${message.text}`;
    if (used + line.length > budget) {
      if (lines.length === 0) lines.push(`${line.slice(0, budget - 1)}…`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return input;
  return [OPENING, ...lines.reverse(), CLOSING, '', input].join('\n');
}

/** `2026-09-28 14:03` in `timeZone`. */
function localTime(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
