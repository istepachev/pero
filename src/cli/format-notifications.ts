import type {
  NotificationDetails,
  NotificationView,
} from '../control/protocol.js';
import { describeChannel, localDateTime } from './format-channels.js';
import { table } from './format-status.js';

/** How much of the last error a table shows. */
const ERROR_PREVIEW = 60;

/** `pero notifications ls`: one row per Notification, newest first. */
export function formatNotificationList(
  notifications: readonly NotificationView[],
  filtered: boolean,
): string {
  if (notifications.length === 0) {
    return filtered
      ? 'No Notifications match.'
      : "No Notifications yet. pero workflows notify <workflow> <channel> posts a Workflow's runs to a Channel.";
  }
  return notificationTable(notifications, true).join('\n');
}

/** The rows of a Notification table, with a header. */
export function notificationTable(
  notifications: readonly NotificationView[],
  withRun: boolean,
): string[] {
  return table([
    [
      'ID',
      ...(withRun ? ['RUN', 'WORKFLOW'] : []),
      'CHANNEL',
      'STATUS',
      'ATTEMPTS',
      'NEXT ATTEMPT',
      'LAST ERROR',
    ],
    ...notifications.map((notification) => [
      String(notification.id),
      ...(withRun ? [String(notification.runId), notification.workflow] : []),
      channel(notification),
      notification.status,
      attempts(notification),
      nextAttempt(notification),
      shorten(notification.lastError ?? '—'),
    ]),
  ]);
}

/**
 * `pero notifications show`: where it goes, how delivery stands, its
 * message, and what the owner can do about it.
 */
export function formatNotificationDetails(
  notification: NotificationDetails,
): string {
  const lines = [
    `Notification ${notification.id} of run ${notification.runId} (Workflow ${notification.workflow})`,
    ...table([
      ['to', describeChannel(notification.channel)],
      ['status', status(notification)],
      ['attempts', attempts(notification)],
      ['next attempt', nextAttempt(notification)],
      ...(notification.lastError === null
        ? []
        : [['last error', notification.lastError]]),
      ...(notification.providerMessageId === null
        ? []
        : [['message ID', notification.providerMessageId]]),
      ['created', localDateTime(new Date(notification.createdAt))],
      ['updated', localDateTime(new Date(notification.updatedAt))],
    ]).map((row) => `  ${row}`),
    '',
  ];
  if (notification.text === null) {
    lines.push('Its payload holds no message.');
  } else {
    lines.push(
      'Message',
      ...notification.text.split('\n').map((line) => `  ${line}`.trimEnd()),
    );
  }
  const hints = diagnose(notification);
  if (hints.length > 0) lines.push('', ...hints);
  return lines.join('\n');
}

/** What stands in the way of delivery, and what to do about it. */
function diagnose(notification: NotificationDetails): string[] {
  if (notification.status === 'delivered') return [];
  const hints = deliveryProblems(notification);
  if (notification.status === 'failed') {
    hints.push(
      `pero notifications retry ${notification.id} tries it again with fresh attempts.`,
    );
  } else if (!notification.delivering && notification.attempt > 0) {
    hints.push(
      `pero notifications retry ${notification.id} tries it now instead of waiting.`,
    );
  }
  return hints;
}

/** What stands in the way of delivering an undelivered Notification. */
export function deliveryProblems(notification: NotificationDetails): string[] {
  const hints: string[] = [];
  if (notification.chatAllowed === false) {
    hints.push(
      "Its Channel's chat is no longer allowed; pero telegram chats lists the chats, and pero telegram allow <chat-id> allows it again.",
    );
  } else if (notification.chatAllowed === null) {
    hints.push(
      `${capitalized(notification.channel.integrationKind)} is not connected, so nothing can be delivered there; pero status shows why.`,
    );
  }
  if (
    notification.chatAllowed !== null &&
    notification.integrationProblem !== null
  ) {
    hints.push(
      `${capitalized(notification.channel.integrationKind)}: ${notification.integrationProblem}; pero status shows more.`,
    );
  }
  return hints;
}

function capitalized(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

function status(notification: NotificationDetails): string {
  return notification.delivering
    ? `${notification.status} (being delivered now)`
    : notification.status;
}

function channel(notification: NotificationView): string {
  const { id, title } = notification.channel;
  return title === null ? String(id) : `${id} ${title}`;
}

function attempts(notification: NotificationView): string {
  return `${notification.attempt}/${notification.maxAttempts}`;
}

function nextAttempt(notification: NotificationView): string {
  return notification.status === 'pending' &&
    notification.nextAttemptAt !== null
    ? localDateTime(new Date(notification.nextAttemptAt))
    : '—';
}

function shorten(text: string): string {
  const line = text.split('\n')[0]!;
  return line.length > ERROR_PREVIEW || line !== text
    ? `${line.slice(0, ERROR_PREVIEW - 1)}…`
    : line;
}
