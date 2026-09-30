import { describe, expect, it } from 'vitest';
import { cronSchema } from '../config/workflow-input.js';
import { DAYS, dayValue, fromCron, toCron } from './schedule.js';

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

describe('fromCron', () => {
  it('inverts toCron exactly', () => {
    for (const expression of [
      '0 12 * * 0',
      '0 9,18 * * 1-5',
      '30 10 * * 0,6',
      '0 7 * * *',
      '45 9-11,15 * * 1-3',
      '5 0 * * 6',
    ]) {
      const schedule = fromCron(expression);
      expect(schedule).not.toBeNull();
      expect(toCron(schedule!)).toBe(expression);
    }
    expect(fromCron('0 9,18 * * 1-5')).toEqual({
      days: [1, 2, 3, 4, 5],
      hours: [9, 18],
      minute: 0,
    });
  });

  it('gives null for what toCron would write otherwise, or cannot write', () => {
    for (const expression of [
      // Written differently by toCron, so the schedule's fingerprint would change.
      '0 9 * * 5,1',
      '0 9 * * 1,2,3',
      '0 9 * * 0-6',
      '0 9 * * MON-FRI',
      '00 9 * * 1',
      // Beyond day, hour, and minute.
      '0 8 1 * *',
      '0 8 * 6 *',
      '*/15 9-17 * * 1-5',
      '0 * * * *',
      '0 9 * * 7',
      '0 24 * * *',
      '@daily',
    ]) {
      expect(fromCron(expression)).toBeNull();
    }
  });
});

describe('dayValue', () => {
  it('names days the way a Workflow note writes them', () => {
    expect(dayValue(DAYS.daily!)).toBeNull();
    expect(dayValue([1, 2, 3, 4, 5])).toBe('weekdays');
    expect(dayValue([6, 0])).toBe('weekends');
    expect(dayValue([0])).toBe('sunday');
    expect(dayValue([5, 1])).toEqual(['monday', 'friday']);
  });
});
