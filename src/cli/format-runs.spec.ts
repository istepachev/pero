import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotificationView, RunDetails } from '../control/protocol.js';
import { formatRunDetails, formatRunList, startedBy } from './format-runs.js';

const RUN: RunDetails = {
  id: 7,
  workflow: 'brief',
  triggerId: 2,
  triggerKey: 'manual:6f1c',
  status: 'completed',
  attempt: 1,
  skippedCount: 0,
  createdAt: '2026-09-29T07:00:00.000Z',
  startedAt: '2026-09-29T07:00:01.000Z',
  finishedAt: '2026-09-29T07:00:09.000Z',
  result: 'Drink water.\nWalk.',
  skipped: false,
  error: null,
  retriedBy: null,
  history: null,
  notifications: [],
};

const NOTIFICATION: NotificationView = {
  id: 4,
  runId: 7,
  workflow: 'brief',
  channel: {
    id: 2,
    integrationKind: 'telegram',
    key: '-100:7',
    title: 'English',
    enabled: true,
  },
  status: 'pending',
  attempt: 2,
  maxAttempts: 10,
  nextAttemptAt: '2026-09-29T07:12:00.000Z',
  lastError: 'Telegram is unreachable: connect ECONNREFUSED',
  providerMessageId: null,
  createdAt: '2026-09-29T07:00:09.000Z',
  updatedAt: '2026-09-29T07:02:00.000Z',
};

describe('run formatting', () => {
  const zone = process.env.TZ;

  beforeEach(() => {
    // UTC+5 all year, so times read the same wherever the tests run.
    process.env.TZ = 'Asia/Tashkent';
  });

  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it('names what started a run', () => {
    expect(startedBy({ triggerKey: 'manual:6f1c' })).toBe('manual');
    expect(startedBy({ triggerKey: 'schedule:3:2026-09-29T07:00' })).toBe(
      'schedule',
    );
    expect(startedBy({ triggerKey: 'retry:5' })).toBe('retry of run 5');
  });

  it('lists runs newest first, or says there are none', () => {
    expect(
      formatRunList(
        [
          {
            ...RUN,
            id: 8,
            triggerKey: 'retry:7',
            status: 'running',
            attempt: 2,
            finishedAt: null,
          },
          { ...RUN, skipped: true, result: null },
        ],
        false,
      ),
    ).toBe(
      [
        'ID  WORKFLOW  STATUS                            ATTEMPT  STARTED BY      CREATED           FINISHED',
        '8   brief     running                           2        retry of run 7  2026-09-29 12:00  —',
        '7   brief     completed (skipped: no messages)  1        manual          2026-09-29 12:00  2026-09-29 12:00',
      ].join('\n'),
    );
    expect(formatRunList([], false)).toBe(
      'No runs yet. pero workflows run <name> starts one by hand.',
    );
    expect(formatRunList([], true)).toBe('No runs match.');
  });

  it('shows a completed run with its answer and Notifications', () => {
    expect(
      formatRunDetails({
        ...RUN,
        history: {
          channels: [2, 3],
          messages: 'people',
          count: 12,
          dropped: 3,
        },
        notifications: [NOTIFICATION],
      }),
    ).toBe(
      [
        'Run 7 of Workflow brief',
        '  status      completed',
        '  attempt     1',
        '  started by  manual',
        '  created     2026-09-29 12:00',
        '  started     2026-09-29 12:00',
        '  finished    2026-09-29 12:00',
        "  history     12 messages from Channels 2, 3, people's (3 oldest left out)",
        '',
        'Answer',
        '  Drink water.',
        '  Walk.',
        '',
        'Notifications',
        '  ID  CHANNEL    STATUS   ATTEMPTS  NEXT ATTEMPT      LAST ERROR',
        '  4   2 English  pending  2/10      2026-09-29 12:12  Telegram is unreachable: connect ECONNREFUSED',
      ].join('\n'),
    );
  });

  it('shows why a run failed, and that it can be retried until it is', () => {
    const failed: RunDetails = {
      ...RUN,
      status: 'failed',
      result: null,
      error: 'The model is overloaded',
      skippedCount: 2,
      triggerKey: 'schedule:3:2026-09-29T07:00',
    };
    const text = formatRunDetails(failed);
    expect(text).toContain('  coalesced   2 later scheduled times');
    expect(text).toContain('\nError\n  The model is overloaded\n');
    expect(text).toContain('Notified no Channel.');
    expect(text).toMatch(/\n\npero runs retry 7 queues it again\.$/);

    const retried = formatRunDetails({ ...failed, retriedBy: 9 });
    expect(retried).toContain('  retried by  run 9');
    expect(retried).not.toContain('pero runs retry');
  });
});
