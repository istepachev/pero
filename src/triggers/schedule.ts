import { Cron } from 'croner';

// Pure: no Nest or TypeORM. Croner matches the cron fields against a naive
// wall-clock time (kept in a Date's UTC fields); this module turns wall-clock
// times into instants with its own daylight-saving policy.

/** A schedule Trigger's rule: a cron expression in an IANA time zone. */
export interface Schedule {
  cron: string;
  timezone: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Far more matches than any daylight-saving overlap can hide (a minute
 * schedule across a two-hour repeat is 120); a guard, not a limit.
 */
const MAX_STEPS = 10_000;

/**
 * The first time strictly after `after` that `schedule` runs, or `null` if
 * no date ever matches (such as `0 9 30 2 *`).
 *
 * The cron fields match local time in the schedule's zone. Where daylight
 * saving changes the clocks:
 * - a local time the clocks skip runs the moment they jump, so a daily
 *   02:30 in Europe/Berlin runs at 03:00 on the day the clocks go forward;
 * - a local time the clocks repeat runs once, at its first occurrence, so
 *   an every-15-minutes schedule does not run while the hour repeats;
 * - times that land on the same instant, such as 02:00 and 03:00 on the day
 *   the clocks go forward, are one run.
 */
export function nextOccurrence(schedule: Schedule, after: Date): Date | null {
  const cron = new Cron(schedule.cron, { timezone: 'UTC', mode: '5-part' });
  let wall = toWallClock(after, schedule.timezone);
  for (let step = 0; step < MAX_STEPS; step++) {
    const match = cron.nextRun(wall);
    if (match === null) return null;
    const instant = toInstant(match, schedule.timezone);
    // Local times map to instants in order, so the first one past `after`
    // is the earliest.
    if (instant.getTime() > after.getTime()) return instant;
    wall = match;
  }
  throw new Error(
    `No occurrence of "${schedule.cron}" in ${schedule.timezone} found after ${after.toISOString()}`,
  );
}

/** Local time in `timeZone` at `instant`, as a Date whose UTC fields hold it. */
export function toWallClock(instant: Date, timeZone: string): Date {
  return new Date(instant.getTime() + offsetAt(instant.getTime(), timeZone));
}

/**
 * The instant local time `wall` (in its UTC fields) names in `timeZone`:
 * the first of two when the clocks repeat it, and the moment they jump when
 * they skip it.
 */
export function toInstant(wall: Date, timeZone: string): Date {
  const local = wall.getTime();
  // Time zones change offset at most once in any two days.
  const oldOffset = offsetAt(local - DAY_MS, timeZone);
  const newOffset = offsetAt(local + DAY_MS, timeZone);
  const valid = [local - oldOffset, local - newOffset].filter(
    (instant) => instant + offsetAt(instant, timeZone) === local,
  );
  if (valid.length > 0) return new Date(Math.min(...valid));
  // Skipped: find the first instant on the new offset. Read with the new
  // offset, `wall` names an instant still on the old one; read with the old
  // offset, an instant already on the new one.
  let low = local - newOffset;
  let high = local - oldOffset;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (offsetAt(middle, timeZone) === newOffset) high = middle;
    else low = middle;
  }
  return new Date(high);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** How far local time in `timeZone` is ahead of UTC at `instant`, in ms. */
function offsetAt(instant: number, timeZone: string): number {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  const field = Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  const local = Date.UTC(
    field.year!,
    field.month! - 1,
    field.day!,
    field.hour!,
    field.minute!,
    field.second!,
  );
  return local - (instant - (((instant % 1000) + 1000) % 1000));
}
