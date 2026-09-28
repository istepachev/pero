/**
 * The newest of `lines` (oldest first) that fit in `budget` characters once
 * joined by newlines, oldest first; one that alone is too long is cut.
 */
export function newestWithin(
  lines: readonly string[],
  budget: number,
): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of [...lines].reverse()) {
    if (used + line.length > budget) {
      if (kept.length === 0) kept.push(`${line.slice(0, budget - 1)}…`);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return kept.reverse();
}

/** `2026-09-28 14:03` in `timeZone`. */
export function localTime(date: Date, timeZone: string): string {
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
