import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotificationDetails } from '../control/protocol.js';
import {
  deliveryProblems,
  formatNotificationDetails,
  formatNotificationList,
} from './format-notifications.js';

const NOTIFICATION: NotificationDetails = {
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
  lastError: `Telegram is unreachable: ${'x'.repeat(80)}`,
  providerMessageId: null,
  createdAt: '2026-09-29T07:00:09.000Z',
  updatedAt: '2026-09-29T07:02:00.000Z',
  text: 'Workflow brief\n\nTry "I went home".',
  chatAllowed: true,
  integrationProblem: null,
  delivering: false,
};

describe('Notification formatting', () => {
  const zone = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = 'Asia/Tashkent';
  });

  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it('lists Notifications with a shortened last error', () => {
    expect(
      formatNotificationList(
        [
          NOTIFICATION,
          {
            ...NOTIFICATION,
            id: 3,
            runId: 6,
            channel: { ...NOTIFICATION.channel, id: 5, title: null },
            status: 'delivered',
            attempt: 1,
            nextAttemptAt: null,
            lastError: null,
            providerMessageId: '99',
          },
        ],
        false,
      ),
    ).toBe(
      [
        'ID  RUN  WORKFLOW  CHANNEL    STATUS     ATTEMPTS  NEXT ATTEMPT      LAST ERROR',
        `4   7    brief     2 English  pending    2/10      2026-09-29 12:12  Telegram is unreachable: ${'x'.repeat(34)}…`,
        '3   6    brief     5          delivered  1/10      —                 —',
      ].join('\n'),
    );
    expect(formatNotificationList([], true)).toBe('No Notifications match.');
  });

  it('shows a pending Notification with its message and how to try it now', () => {
    expect(formatNotificationDetails(NOTIFICATION)).toBe(
      [
        'Notification 4 of run 7 (Workflow brief)',
        '  to            Channel 2 (telegram -100:7 "English")',
        '  status        pending',
        '  attempts      2/10',
        '  next attempt  2026-09-29 12:12',
        `  last error    Telegram is unreachable: ${'x'.repeat(80)}`,
        '  created       2026-09-29 12:00',
        '  updated       2026-09-29 12:02',
        '',
        'Message',
        '  Workflow brief',
        '',
        '  Try "I went home".',
        '',
        'pero notifications retry 4 tries it now instead of waiting.',
      ].join('\n'),
    );
  });

  it('says what stands in the way of delivery', () => {
    const failed: NotificationDetails = {
      ...NOTIFICATION,
      status: 'failed',
      nextAttemptAt: null,
      lastError: 'the chat is no longer allowed',
      chatAllowed: false,
    };
    const text = formatNotificationDetails(failed);
    expect(text).toContain('  next attempt  —');
    expect(text).toMatch(
      /\n\nIts Channel's chat is no longer allowed; pero telegram chats lists the chats, and pero telegram allow <chat-id> allows it again\.\npero notifications retry 4 tries it again with fresh attempts\.$/,
    );
    expect(
      deliveryProblems({
        ...NOTIFICATION,
        integrationProblem: 'Bot token is not set',
      }),
    ).toEqual(['Telegram: Bot token is not set; pero status shows more.']);
    expect(deliveryProblems({ ...NOTIFICATION, chatAllowed: null })).toEqual([
      'Telegram is not connected, so nothing can be delivered there; pero status shows why.',
    ]);
    expect(
      formatNotificationDetails({ ...NOTIFICATION, delivering: true }),
    ).toContain('  status        pending (being delivered now)');
    expect(
      formatNotificationDetails({ ...NOTIFICATION, delivering: true }),
    ).not.toContain('pero notifications retry');
  });

  it('shows a delivered Notification without hints', () => {
    const text = formatNotificationDetails({
      ...NOTIFICATION,
      status: 'delivered',
      nextAttemptAt: null,
      lastError: null,
      providerMessageId: '99',
      chatAllowed: false,
    });
    expect(text).toContain('  message ID    99');
    expect(text).not.toContain('last error');
    expect(text).toMatch(/Try "I went home"\.$/);
  });
});
