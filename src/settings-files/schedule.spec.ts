import { describe, expect, it } from 'vitest';
import { cronSchema } from '../config/workflow-input.js';
import { DAYS, toCron } from './schedule.js';

describe('toCron', () => {
  const cron = (day: string | string[], hours: number[], minute = 0) =>
    toCron({
      days: (Array.isArray(day) ? day : [day]).flatMap((d) => DAYS[d]!),
      hours,
      minute,
    });

  it('maps the examples from the configuration reference', () => {
    expect(cron('sunday', [12])).toBe('0 12 * * 0');
    expect(cron('weekdays', [9, 18])).toBe('0 9,18 * * 1-5');
  });

  it('maps every day keyword', () => {
    expect(cron('daily', [7])).toBe('0 7 * * *');
    expect(cron('weekends', [10], 30)).toBe('30 10 * * 0,6');
    expect(cron('monday', [8])).toBe('0 8 * * 1');
    expect(cron('saturday', [8])).toBe('0 8 * * 6');
  });

  it('sorts lists of days and hours and drops repeats', () => {
    expect(cron(['friday', 'monday', 'friday'], [18, 9, 9])).toBe(
      '0 9,18 * * 1,5',
    );
    expect(cron(['saturday', 'sunday'], [0])).toBe('0 0 * * 0,6');
    expect(cron(['weekdays', 'saturday', 'sunday'], [6])).toBe('0 6 * * *');
  });

  it('writes runs of three or more as ranges', () => {
    expect(cron(['monday', 'tuesday', 'wednesday'], [9, 10, 11, 15])).toBe(
      '0 9-11,15 * * 1-3',
    );
    expect(
      cron(
        'daily',
        Array.from({ length: 24 }, (_, hour) => hour),
      ),
    ).toBe('0 * * * *');
  });

  it('makes expressions the cron schema accepts unchanged', () => {
    for (const expression of [
      cron('sunday', [12]),
      cron('weekdays', [9, 18], 45),
      cron(['monday', 'wednesday', 'friday'], [0, 23], 59),
    ]) {
      expect(cronSchema.parse(expression)).toBe(expression);
    }
  });
});
