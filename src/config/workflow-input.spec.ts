import { describe, expect, it } from 'vitest';
import { InvalidInputError, parseInput } from '../common/errors.js';
import { cronSchema, workflowHistorySchema } from './workflow-input.js';

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

describe('workflowHistorySchema', () => {
  it('takes all Channels or a list, sorted without repeats', () => {
    const defaults = {
      channels: 'all',
      messages: 'people',
      hours: null,
      runWhenEmpty: false,
    };
    expect(workflowHistorySchema.parse(defaults)).toEqual(defaults);
    expect(
      workflowHistorySchema.parse({
        channels: [5, 3, 5],
        messages: 'all',
        hours: 720,
        runWhenEmpty: true,
      }),
    ).toEqual({
      channels: [3, 5],
      messages: 'all',
      hours: 720,
      runWhenEmpty: true,
    });
  });

  it('refuses no Channels, windows out of range, and unknown fields', () => {
    const valid = {
      channels: 'all',
      messages: 'people',
      hours: null,
      runWhenEmpty: false,
    };
    expect(() =>
      parseInput(workflowHistorySchema, { ...valid, channels: [] }),
    ).toThrow('channels: must be all, or the IDs of one or more Channels');
    expect(() =>
      parseInput(workflowHistorySchema, { ...valid, hours: 0 }),
    ).toThrow('hours: must be at least 1');
    expect(() =>
      parseInput(workflowHistorySchema, { ...valid, hours: 721 }),
    ).toThrow('hours: must be at most 720');
    expect(() =>
      parseInput(workflowHistorySchema, { ...valid, messages: 'agents' }),
    ).toThrow(InvalidInputError);
    expect(() =>
      parseInput(workflowHistorySchema, { ...valid, direction: 'in' }),
    ).toThrow(InvalidInputError);
  });
});
