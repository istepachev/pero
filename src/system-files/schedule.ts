// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** Weekday names in cron order: `sunday` is 0. */
export const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/** Every value a Workflow's `day` takes, with the cron weekdays it means. */
export const DAYS: Readonly<Record<string, readonly number[]>> = {
  daily: [0, 1, 2, 3, 4, 5, 6],
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6],
  ...Object.fromEntries(WEEKDAYS.map((day, index) => [day, [index]])),
};

/** A schedule as a Workflow note writes it, in cron's numbers. */
export interface WallClockSchedule {
  /** Weekdays, `sunday` as 0. */
  days: readonly number[];
  hours: readonly number[];
  minute: number;
}

/**
 * The five-field cron expression that runs at `minute` past each of
 * `hours` on each of `days`: `sunday` at 12 is `0 12 * * 0`, and weekdays
 * at 9 and 18 is `0 9,18 * * 1-5`.
 */
export function toCron({ days, hours, minute }: WallClockSchedule): string {
  return `${minute} ${field(hours, 24)} * * ${field(days, 7)}`;
}

/**
 * `values` as a cron field: `*` when they are all `size` values, otherwise
 * ascending, with runs of three or more written as ranges.
 */
function field(values: readonly number[], size: number): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (sorted.length === size) return '*';
  const parts: string[] = [];
  for (let start = 0; start < sorted.length;) {
    let end = start;
    while (sorted[end + 1] === sorted[end]! + 1) end++;
    parts.push(
      end - start >= 2
        ? `${sorted[start]}-${sorted[end]}`
        : sorted.slice(start, end + 1).join(','),
    );
    start = end + 1;
  }
  return parts.join(',');
}
