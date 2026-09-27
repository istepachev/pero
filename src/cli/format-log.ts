const LEVELS: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

/** Fields shown in the line's prefix, or not at all. */
const OMITTED = new Set(['time', 'level', 'msg', 'context', 'pid', 'hostname']);

/**
 * One `pero.log` JSON line as a line for people: local time, level, context,
 * message, remaining fields as `key=value`, and any stack trace indented
 * below. A line that is not a JSON object is returned unchanged.
 */
export function formatLogLine(line: string): string {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return line;
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return line;
  }
  const record = entry as Record<string, unknown>;

  const head = [formatTime(record.time), formatLevel(record.level)];
  if (record.context !== undefined) head.push(`[${text(record.context)}]`);
  if (record.msg !== undefined) head.push(text(record.msg));

  const traces: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (OMITTED.has(key)) continue;
    if (key === 'err' && isObject(value)) {
      const { message, stack, ...rest } = value;
      const trace = typeof stack === 'string' ? stack : message;
      if (trace !== undefined) traces.push(text(trace));
      for (const [field, fieldValue] of Object.entries(rest)) {
        head.push(`err.${field}=${formatValue(fieldValue)}`);
      }
    } else if (key === 'stack' && typeof value === 'string') {
      traces.push(value);
    } else {
      head.push(`${key}=${formatValue(value)}`);
    }
  }

  const lines = [
    head
      .filter((part) => part !== '')
      .join(' ')
      .trimEnd(),
  ];
  for (const trace of traces) {
    lines.push(...trace.split('\n').map((row) => `    ${row}`));
  }
  return lines.join('\n');
}

/** `YYYY-MM-DD HH:mm:ss.SSS` in the local time zone. */
function formatTime(time: unknown): string {
  const date =
    typeof time === 'string' || typeof time === 'number'
      ? new Date(time)
      : null;
  if (!date || Number.isNaN(date.getTime())) {
    return time === undefined ? '' : text(time);
  }
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}`
  );
}

function formatLevel(level: unknown): string {
  if (level === undefined) return '';
  const label = typeof level === 'number' ? LEVELS[level] : undefined;
  return (label ?? text(level)).padEnd(5);
}

/** Bare when unambiguous; JSON otherwise. */
function formatValue(value: unknown): string {
  if (typeof value === 'string' && value !== '' && !/[\s="]/.test(value)) {
    return value;
  }
  return JSON.stringify(value) ?? String(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : formatValue(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
