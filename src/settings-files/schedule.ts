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

/**
 * The wall-clock schedule that `toCron` turns into exactly `cron`; null
 * when there is none, and the Workflow needs `cron` itself. Only a single
 * minute, listed hours, and weekdays qualify: every day of the month and
 * every month.
 */
export function fromCron(cron: string): WallClockSchedule | null {
  const fields = cron.split(' ');
  if (fields.length !== 5) return null;
  const [minuteField, hourField, dayOfMonth, month, dayField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (dayOfMonth !== '*' || month !== '*' || hourField === '*') return null;
  const minute = /^\d+$/.test(minuteField) ? Number(minuteField) : null;
  const hours = values(hourField);
  const days = dayField === '*' ? DAYS.daily! : values(dayField);
  if (minute === null || minute > 59 || hours === null || days === null) {
    return null;
  }
  if (hours.some((hour) => hour > 23) || days.some((day) => day > 6)) {
    return null;
  }
  const schedule = { days, hours, minute };
  return toCron(schedule) === cron ? schedule : null;
}

/** The numbers a cron field of numbers and ranges lists; null otherwise. */
function values(field: string): number[] | null {
  const numbers: number[] = [];
  for (const part of field.split(',')) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (range === null) return null;
    const start = Number(range[1]);
    const end = range[2] === undefined ? start : Number(range[2]);
    // Minutes and hours stop at 59: anything past is no wall-clock time.
    if (end < start || end > 59) return null;
    for (let value = start; value <= end; value++) numbers.push(value);
  }
  return numbers;
}

/**
 * How a Workflow note writes `days`: a keyword such as `weekdays`, or the
 * weekdays by name; null for every day, which is the default.
 */
export function dayValue(days: readonly number[]): string | string[] | null {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const same = (other: readonly number[]) =>
    other.length === sorted.length &&
    other.every((day, index) => day === sorted[index]);
  if (same(DAYS.daily!)) return null;
  for (const keyword of ['weekdays', 'weekends'] as const) {
    if (same(DAYS[keyword]!)) return keyword;
  }
  const names = sorted.map((day) => WEEKDAYS[day]!);
  return names.length === 1 ? names[0]! : names;
}
