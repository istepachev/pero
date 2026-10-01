import { describe, expect, it } from 'vitest';
import { parseInput } from '../common/errors.js';
import { cronSchema } from './workflow-input.js';

describe('cronSchema', () => {
  it.each([
    ['0 9 * * *', '0 9 * * *'],
    ['  */15   9-17 * *\tmon-fri ', '*/15 9-17 * * mon-fri'],
    ['0 9 L * *', '0 9 L * *'],
    ['@daily', '@daily'],
    ['@Weekly', '@weekly'],
  ])('accepts %j as %j', (value, cron) => {
    expect(cronSchema.parse(value)).toBe(cron);
  });

  it.each(['0 0 9 * * *', '0 9 * *', '', 'every day', '@reboot', '@often'])(
    'refuses %j, asking for five fields',
    (value) => {
      expect(() => parseInput(cronSchema, value)).toThrow(
        'must be a cron expression of five fields (minute hour day month weekday), such as "0 9 * * *", or @hourly, @daily, @weekly, @monthly, or @yearly',
      );
    },
  );

  it('says which field is out of range', () => {
    expect(() => parseInput(cronSchema, '61 9 * * *')).toThrow(
      /such as "0 9 \* \* \*".*\(Invalid value for minute: 61\)$/,
    );
  });
});
