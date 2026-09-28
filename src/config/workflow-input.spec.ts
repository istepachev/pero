import { describe, expect, it } from 'vitest';
import { InvalidInputError, parseInput } from '../common/errors.js';
import {
  cronSchema,
  DEFAULT_WORKFLOW_HISTORY,
  patchHistory,
  triggerAddSchema,
  workflowCreateSchema,
  workflowEditSchema,
  workflowHistoryPatchSchema,
  workflowHistorySchema,
} from './workflow-input.js';

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

describe('workflowCreateSchema', () => {
  it('lowercases the name and keeps the input as given', () => {
    expect(
      workflowCreateSchema.parse({
        name: 'Evening-Review',
        agent: ' coach ',
        inputTemplate: '  Review today.\n',
      }),
    ).toEqual({
      name: 'evening-review',
      agent: 'coach',
      inputTemplate: '  Review today.\n',
    });
  });

  it('refuses a blank input, a missing Agent, and unknown fields', () => {
    expect(() =>
      parseInput(workflowCreateSchema, {
        name: 'review',
        agent: '',
        inputTemplate: ' \n',
      }),
    ).toThrow('agent: must not be empty; inputTemplate: must not be empty');
    expect(() =>
      parseInput(workflowCreateSchema, {
        name: 'review',
        agent: 'coach',
        inputTemplate: 'Go',
        cron: '0 9 * * *',
      }),
    ).toThrow(InvalidInputError);
  });

  it('refuses a name that is not a slug', () => {
    expect(() =>
      parseInput(workflowCreateSchema, {
        name: 'evening review',
        agent: 'coach',
        inputTemplate: 'Go',
      }),
    ).toThrow(
      'name: must be letters and digits, in words joined by single hyphens',
    );
  });
});

describe('workflowEditSchema', () => {
  it('takes any subset of fields and clears the title with null', () => {
    expect(workflowEditSchema.parse({})).toEqual({});
    expect(workflowEditSchema.parse({ title: null, enabled: false })).toEqual({
      title: null,
      enabled: false,
    });
  });
});

describe('triggerAddSchema', () => {
  it('takes a schedule with an optional time zone in its canonical spelling', () => {
    expect(
      triggerAddSchema.parse({
        workflow: 'review',
        kind: 'schedule',
        cron: '0  21 * * *',
        timezone: 'europe/berlin',
      }),
    ).toEqual({
      workflow: 'review',
      kind: 'schedule',
      cron: '0 21 * * *',
      timezone: 'Europe/Berlin',
    });
    expect(
      triggerAddSchema.parse({
        workflow: 'review',
        kind: 'schedule',
        cron: '@daily',
      }),
    ).toEqual({ workflow: 'review', kind: 'schedule', cron: '@daily' });
  });

  it('refuses a time zone that is not IANA', () => {
    expect(() =>
      parseInput(triggerAddSchema, {
        workflow: 'review',
        kind: 'schedule',
        cron: '0 21 * * *',
        timezone: '+05:00',
      }),
    ).toThrow('timezone: must be an IANA time zone such as Europe/Berlin');
  });

  it('takes a manual Trigger without a schedule or time zone', () => {
    expect(
      triggerAddSchema.parse({ workflow: 'review', kind: 'manual' }),
    ).toEqual({ workflow: 'review', kind: 'manual' });
    expect(() =>
      parseInput(triggerAddSchema, {
        workflow: 'review',
        kind: 'manual',
        cron: '0 9 * * *',
      }),
    ).toThrow(InvalidInputError);
    expect(() =>
      parseInput(triggerAddSchema, {
        workflow: 'review',
        kind: 'manual',
        timezone: 'UTC',
      }),
    ).toThrow(InvalidInputError);
  });

  it('refuses an unknown kind', () => {
    expect(() =>
      parseInput(triggerAddSchema, { workflow: 'review', kind: 'webhook' }),
    ).toThrow(InvalidInputError);
  });
});

describe('workflowHistorySchema', () => {
  it('takes all Channels or a list, sorted without repeats', () => {
    expect(workflowHistorySchema.parse(DEFAULT_WORKFLOW_HISTORY)).toEqual(
      DEFAULT_WORKFLOW_HISTORY,
    );
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
    expect(() =>
      parseInput(workflowHistoryPatchSchema, { channels: [] }),
    ).toThrow('channels: must be all, or the IDs of one or more Channels');
    expect(() => parseInput(workflowHistoryPatchSchema, { hours: 0 })).toThrow(
      'hours: must be at least 1',
    );
    expect(() =>
      parseInput(workflowHistoryPatchSchema, { hours: 721 }),
    ).toThrow('hours: must be at most 720');
    expect(() =>
      parseInput(workflowHistoryPatchSchema, { messages: 'agents' }),
    ).toThrow(InvalidInputError);
    expect(() =>
      parseInput(workflowHistoryPatchSchema, { direction: 'in' }),
    ).toThrow(InvalidInputError);
  });

  it('patches the defaults, or the current history input', () => {
    expect(patchHistory(null, {})).toEqual(DEFAULT_WORKFLOW_HISTORY);
    expect(patchHistory(null, { hours: 12 })).toEqual({
      ...DEFAULT_WORKFLOW_HISTORY,
      hours: 12,
    });
    expect(
      patchHistory(
        { channels: [3], messages: 'all', hours: 12, runWhenEmpty: true },
        { hours: null, runWhenEmpty: undefined },
      ),
    ).toEqual({
      channels: [3],
      messages: 'all',
      hours: null,
      runWhenEmpty: true,
    });
  });

  it('is optional on create, and cleared with null on edit', () => {
    expect(
      workflowCreateSchema.parse({
        name: 'coach',
        agent: 'coach',
        inputTemplate: 'Review {{history}}',
        history: { messages: 'people' },
      }).history,
    ).toEqual({ messages: 'people' });
    expect(workflowEditSchema.parse({ history: null })).toEqual({
      history: null,
    });
  });
});
