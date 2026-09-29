import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  NotificationTargetView,
  RunView,
  TriggerView,
  WorkflowDetails,
  WorkflowView,
} from '../control/protocol.js';
import {
  agentWarning,
  describeScheduledTrigger,
  describeTrigger,
  formatNotify,
  formatTriggerList,
  formatWorkflowDetails,
  formatWorkflowList,
  runOutcome,
} from './format-workflows.js';

const review: WorkflowView = {
  name: 'evening-review',
  title: 'Evening review',
  agent: 'coach',
  agentEnabled: true,
  inputTemplate: "Review today's chats.\nSuggest one improvement.",
  enabled: true,
  concurrencyPolicy: 'serial',
  maxAttempts: 1,
  history: null,
  triggerCount: 2,
  createdAt: '2026-09-28T09:00:00.000Z',
  updatedAt: '2026-09-28T09:00:00.000Z',
};

const schedule: TriggerView = {
  id: 3,
  workflow: 'evening-review',
  kind: 'schedule',
  cron: '0 21 * * *',
  timezone: 'Europe/Berlin',
  nextRunAt: null,
  lastRunAt: null,
  enabled: true,
};

const manual: TriggerView = {
  ...schedule,
  id: 4,
  kind: 'manual',
  cron: null,
  timezone: null,
  enabled: false,
};

const english: NotificationTargetView = {
  id: 5,
  integrationKind: 'telegram',
  key: '-100777:7',
  title: 'English',
  enabled: true,
};

describe('Workflow formatting', () => {
  const zone = process.env.TZ;

  // A fixed offset, so local time is provably not the recorded UTC.
  beforeAll(() => {
    process.env.TZ = 'Etc/GMT-5';
  });

  afterAll(() => {
    process.env.TZ = zone;
  });

  it('lists Workflows with their Agent, Triggers, and state', () => {
    expect(
      formatWorkflowList([
        { ...review, name: 'brief', agentEnabled: false, triggerCount: 0 },
        review,
      ]),
    ).toBe(
      [
        'NAME            AGENT             TRIGGERS  STATE',
        'brief           coach (disabled)  0         enabled',
        'evening-review  coach             2         enabled',
      ].join('\n'),
    );
  });

  it('says how to create the first Workflow', () => {
    expect(formatWorkflowList([])).toBe(
      'No Workflows yet. Create one with pero workflows create <name> --agent <agent> --input <text>.',
    );
  });

  it('shows a Workflow with its Triggers and the Channels it notifies', () => {
    const details: WorkflowDetails = {
      ...review,
      triggers: [
        { ...schedule, nextRunAt: '2026-09-28T19:00:00.000Z' },
        { ...schedule, id: 5, enabled: false },
        manual,
      ],
      targets: [english, { ...english, id: 9, key: '1234', title: null }],
    };

    expect(formatWorkflowDetails(details)).toBe(
      [
        'Workflow evening-review "Evening review"',
        '  agent     coach',
        "  input     Review today's chats. (2 lines)",
        '  runs      one at a time',
        '  attempts  1 (a run Pero stops is not started again)',
        '  history   none',
        '  state     enabled',
        '',
        'Triggers',
        '  ID  SCHEDULE                  NEXT RUN          STATE',
        '  3   0 21 * * * Europe/Berlin  2026-09-29 00:00  enabled',
        '  5   0 21 * * * Europe/Berlin  —                 disabled',
        '  4   manual                    —                 disabled',
        '',
        'Notifies',
        '  ID  CHANNEL             TITLE    STATE',
        '  5   telegram -100777:7  English  enabled',
        '  9   telegram 1234       —        enabled',
      ].join('\n'),
    );
  });

  it('says how to add a Trigger and warns about a disabled Agent', () => {
    expect(
      formatWorkflowDetails({
        ...review,
        title: null,
        agentEnabled: false,
        maxAttempts: 3,
        history: {
          channels: [3, 5],
          messages: 'all',
          hours: 12,
          runWhenEmpty: true,
        },
        triggerCount: 0,
        triggers: [],
        targets: [],
      }),
    ).toBe(
      [
        'Workflow evening-review',
        '  agent     coach (disabled)',
        "  input     Review today's chats. (2 lines)",
        '  runs      one at a time',
        '  attempts  up to 3 (a run Pero stops starts again when Pero does)',
        '  history   all messages in Channels 3, 5 from the last 12 hours; runs even when there are none',
        '  state     enabled',
        '',
        'Warning: Agent coach is disabled, so this Workflow cannot run until pero agents enable coach.',
        '',
        'No Trigger yet: pero triggers add evening-review --cron "<expression>" or --manual.',
        '',
        'Notifies no Channel: pero workflows notify evening-review <channel> posts its answers there.',
      ].join('\n'),
    );
    expect(agentWarning(review)).toBeNull();
  });

  it('says what notify changed', () => {
    const notifying: WorkflowDetails = {
      ...review,
      triggers: [],
      targets: [english],
    };
    const none: WorkflowDetails = { ...notifying, targets: [] };

    expect(formatNotify(notifying, 5, true, true)).toBe(
      'Workflow evening-review now notifies Channel 5 (telegram -100777:7 "English"): each answer, and each run that fails, is posted there.',
    );
    expect(formatNotify(notifying, 5, true, false)).toBe(
      'Workflow evening-review already notifies Channel 5 (telegram -100777:7 "English").',
    );
    expect(
      formatNotify(
        { ...notifying, targets: [{ ...english, enabled: false }] },
        5,
        true,
        true,
      ).split('\n')[1],
    ).toBe(
      'Note: Channel 5 (telegram -100777:7 "English") is disabled, so its Agent does not answer there; pero channels enable 5 turns it back on.',
    );
    expect(formatNotify(none, 5, false, true)).toBe(
      'Workflow evening-review no longer notifies Channel 5.',
    );
    expect(formatNotify(none, 5, false, false)).toBe(
      'Workflow evening-review did not notify Channel 5.',
    );
  });

  it('lists Triggers with their Workflow', () => {
    expect(formatTriggerList([schedule, manual])).toBe(
      [
        'ID  WORKFLOW        SCHEDULE                  NEXT RUN  STATE',
        '3   evening-review  0 21 * * * Europe/Berlin  none      enabled',
        '4   evening-review  manual                    —         disabled',
      ].join('\n'),
    );
    expect(formatTriggerList([])).toBe(
      'No Triggers yet. Add one with pero triggers add <workflow> --cron "0 9 * * *" or --manual.',
    );
  });

  it('describes a Trigger in one line', () => {
    expect(describeTrigger(schedule)).toBe(
      'Trigger 3 of evening-review (0 21 * * * Europe/Berlin)',
    );
    expect(describeTrigger(manual)).toBe(
      'Trigger 4 of evening-review (manual)',
    );
    expect(
      describeScheduledTrigger({
        ...schedule,
        nextRunAt: '2026-09-28T19:00:00.000Z',
      }),
    ).toBe(
      'Trigger 3 of evening-review (0 21 * * * Europe/Berlin), next run 2026-09-29 00:00',
    );
    expect(describeScheduledTrigger(schedule)).toBe(describeTrigger(schedule));
    expect(describeScheduledTrigger(manual)).toBe(describeTrigger(manual));
  });

  it("gives a finished run's answer, or why there is none", () => {
    const run: RunView = {
      id: 7,
      workflow: 'evening-review',
      triggerId: 4,
      triggerKey: 'manual:0f8c',
      status: 'completed',
      attempt: 1,
      skippedCount: 0,
      createdAt: '2026-09-28T19:00:00.000Z',
      startedAt: '2026-09-28T19:00:01.000Z',
      finishedAt: '2026-09-28T19:00:09.000Z',
      result: 'Two suggestions.',
      skipped: false,
      error: null,
    };
    expect(runOutcome(run)).toEqual({ ok: true, text: 'Two suggestions.' });
    expect(runOutcome({ ...run, result: null, skipped: true })).toEqual({
      ok: true,
      text: 'Run 7 of Workflow evening-review skipped: no messages in its history window',
    });
    expect(
      runOutcome({
        ...run,
        status: 'failed',
        result: null,
        error: 'The model is overloaded',
      }),
    ).toEqual({
      ok: false,
      text: 'Run 7 of Workflow evening-review failed: The model is overloaded',
    });
    expect(
      runOutcome({ ...run, status: 'interrupted', result: null, error: null }),
    ).toEqual({
      ok: false,
      text: 'Run 7 of Workflow evening-review interrupted: no reason was recorded',
    });
  });
});
