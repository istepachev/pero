import { describe, expect, it } from 'vitest';
import { CliError } from './errors.js';
import {
  renameWorkflowFields,
  triggerKind,
  workflowChange,
} from './workflow-options.js';

const context = {
  stdin: () => Promise.resolve("Review today's chats.\nBe kind."),
};

describe('workflowChange', () => {
  it('leaves out every option not given', async () => {
    expect(await workflowChange({}, context)).toEqual({});
  });

  it('maps each option to its field', async () => {
    expect(
      await workflowChange(
        { title: 'Review', agent: 'coach', input: 'Go' },
        context,
      ),
    ).toEqual({ title: 'Review', agent: 'coach', inputTemplate: 'Go' });
  });

  it('passes --max-attempts on', async () => {
    expect(await workflowChange({ maxAttempts: 3 }, context)).toEqual({
      maxAttempts: 3,
    });
  });

  it('clears the title with --no-title', async () => {
    expect(await workflowChange({ title: false }, context)).toEqual({
      title: null,
    });
  });

  it('reads the input from stdin for -', async () => {
    expect(await workflowChange({ input: '-' }, context)).toEqual({
      inputTemplate: "Review today's chats.\nBe kind.",
    });
  });

  it('refuses a blank input', async () => {
    await expect(
      workflowChange({ input: '-' }, { stdin: () => Promise.resolve('\n') }),
    ).rejects.toThrow(
      new CliError('No input given; --input needs the text each run sends'),
    );
  });
});

describe('triggerKind', () => {
  it('makes a schedule of --cron, with --timezone when given', () => {
    expect(triggerKind({ cron: '0 9 * * *' })).toEqual({
      kind: 'schedule',
      cron: '0 9 * * *',
    });
    expect(triggerKind({ cron: '@daily', timezone: 'UTC' })).toEqual({
      kind: 'schedule',
      cron: '@daily',
      timezone: 'UTC',
    });
  });

  it('makes a manual Trigger of --manual', () => {
    expect(triggerKind({ manual: true })).toEqual({ kind: 'manual' });
  });

  it('wants exactly one of --cron and --manual, and --timezone only with --cron', () => {
    expect(() => triggerKind({})).toThrow(
      'Give a schedule with --cron "<expression>", such as --cron "0 9 * * *", or --manual',
    );
    expect(() => triggerKind({ cron: '@daily', manual: true })).toThrow(
      'Give either --cron or --manual, not both',
    );
    expect(() => triggerKind({ manual: true, timezone: 'UTC' })).toThrow(
      '--timezone goes with --cron; a manual Trigger has none',
    );
  });
});

describe('renameWorkflowFields', () => {
  it('names the options instead of the fields', () => {
    expect(
      renameWorkflowFields(
        'change.agent: must not be empty; inputTemplate: must not be empty',
      ),
    ).toBe('--agent: must not be empty; --input: must not be empty');
    expect(
      renameWorkflowFields(
        'name: must be letters and digits; cron: must be a cron expression; timezone: must be an IANA time zone',
      ),
    ).toBe(
      '<name>: must be letters and digits; --cron: must be a cron expression; --timezone: must be an IANA time zone',
    );
    expect(renameWorkflowFields('change.maxAttempts: must be at most 10')).toBe(
      '--max-attempts: must be at most 10',
    );
  });

  it('leaves other messages alone', () => {
    expect(renameWorkflowFields('Agent coach is disabled')).toBe(
      'Agent coach is disabled',
    );
  });
});
