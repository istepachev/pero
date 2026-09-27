import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatLogLine } from './format-log.js';

const time = '2026-09-28T10:04:05.123Z';

const line = (fields: Record<string, unknown>) =>
  JSON.stringify({ level: 30, time, pid: 42, hostname: 'vps', ...fields });

describe('formatLogLine', () => {
  const zone = process.env.TZ;

  // A fixed offset, so local time is provably not the recorded UTC.
  beforeAll(() => {
    process.env.TZ = 'Asia/Tashkent';
  });

  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it('shows local time, level, context, and message', () => {
    expect(
      formatLogLine(line({ context: 'ControlService', msg: 'Pero started' })),
    ).toBe('2026-09-28 15:04:05.123 INFO  [ControlService] Pero started');
  });

  it.each([
    [10, 'TRACE'],
    [20, 'DEBUG'],
    [30, 'INFO '],
    [40, 'WARN '],
    [50, 'ERROR'],
    [60, 'FATAL'],
    [35, '35   '],
  ])('labels level %i as %s', (level, label) => {
    expect(formatLogLine(line({ level, msg: 'm' }))).toBe(
      `2026-09-28 15:04:05.123 ${label} m`,
    );
  });

  it('prints other fields as key=value, quoting when needed', () => {
    expect(
      formatLogLine(
        line({
          msg: 'turn',
          agentId: 'a1',
          reason: 'shutdown request',
          empty: '',
          durationMs: 12,
          ok: true,
          params: ['x'],
        }),
      ),
    ).toBe(
      '2026-09-28 15:04:05.123 INFO  turn agentId=a1 reason="shutdown request" ' +
        'empty="" durationMs=12 ok=true params=["x"]',
    );
  });

  it('indents an error stack below the entry', () => {
    const stack = 'Error: boom\n    at run (file.js:1:1)';
    expect(
      formatLogLine(
        line({
          level: 50,
          msg: 'failed',
          err: { type: 'Error', message: 'boom', stack },
        }),
      ),
    ).toBe(
      [
        '2026-09-28 15:04:05.123 ERROR failed err.type=Error',
        '    Error: boom',
        '        at run (file.js:1:1)',
      ].join('\n'),
    );
  });

  it('shows an error message when there is no stack, and a bare stack field', () => {
    expect(
      formatLogLine(
        line({
          msg: 'm',
          err: { message: 'boom' },
          stack: 'Error: x\n    at y',
        }),
      ),
    ).toBe(
      [
        '2026-09-28 15:04:05.123 INFO  m',
        '    boom',
        '    Error: x',
        '        at y',
      ].join('\n'),
    );
  });

  it('keeps a line without context or message tidy', () => {
    expect(formatLogLine(line({}))).toBe('2026-09-28 15:04:05.123 INFO');
  });

  it.each([
    ['text that is not JSON'],
    ['{"level":30,"msg":"torn'],
    ['42'],
    ['null'],
    ['["a"]'],
  ])('returns %j unchanged', (text) => {
    expect(formatLogLine(text)).toBe(text);
  });
});
