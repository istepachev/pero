import { setTimeout as sleep } from 'node:timers/promises';
import { Command, CommandRunner, Option, SubCommand } from 'nest-commander';
import type { ControlClient } from '../../control/client.js';
import {
  DEFAULT_LISTED,
  type NotificationDetails,
} from '../../control/protocol.js';
import {
  NOTIFICATION_STATUSES,
  type NotificationStatus,
} from '../../persistence/entities/sql.js';
import { channelId } from '../channel-id.js';
import { CliError } from '../errors.js';
import { localDateTime } from '../format-channels.js';
import {
  deliveryProblems,
  formatNotificationDetails,
  formatNotificationList,
} from '../format-notifications.js';
import { listLimit, oneOf } from '../list-options.js';
import { PeroCommand } from '../pero-command.js';
import { positiveInt } from '../positive-int.js';

const NOTIFICATION = {
  notification: 'the Notification ID, as pero notifications ls lists it',
};

/** How often `retry` asks how its attempt went. */
const ATTEMPT_POLL_MS = 500;

/** How long `retry` waits for its attempt before leaving it to Pero. */
export const ATTEMPT_WAIT_MS = 30_000;

/** Notification `value` as an ID; a `CliError` when it is not one. */
function notificationId(value: string): number {
  const id = positiveInt(value);
  if (id === null) {
    throw new CliError(
      `notification must be a Notification ID, not "${value}"`,
    );
  }
  return id;
}

interface NotificationsListOptions {
  status?: NotificationStatus;
  workflow?: string;
  channel?: number;
  run?: number;
  lines?: number;
}

@SubCommand({
  name: 'ls',
  description:
    'List the latest Notifications, newest first, with how delivery stands',
  options: { isDefault: true },
})
export class NotificationsListCommand extends PeroCommand {
  async run(_: string[], options: NotificationsListOptions): Promise<void> {
    const { lines, ...filter } = options;
    const { client } = await this.requireDaemon();
    const { notifications } = await client.call('notifications.list', {
      ...filter,
      limit: lines ?? DEFAULT_LISTED,
    });
    console.log(
      formatNotificationList(notifications, Object.keys(filter).length > 0),
    );
  }

  @Option({
    flags: '--status <status>',
    description: `only Notifications with this status: ${NOTIFICATION_STATUSES.join(', ')}`,
  })
  parseStatus(value: string): NotificationStatus {
    return oneOf('--status', value, NOTIFICATION_STATUSES);
  }

  @Option({
    flags: '--workflow <name>',
    description: "only the Notifications of this Workflow's runs",
  })
  parseWorkflow(value: string): string {
    return value;
  }

  @Option({
    flags: '--channel <channel>',
    description: 'only the Notifications to this Channel, by ID',
  })
  parseChannel(value: string): number {
    return channelId(value);
  }

  @Option({
    flags: '--run <run>',
    description: 'only the Notifications of this run, by ID',
  })
  parseRun(value: string): number {
    const id = positiveInt(value);
    if (id === null)
      throw new CliError(`--run must be a run ID, not "${value}"`);
    return id;
  }

  @Option({
    flags: '-n, --lines <count>',
    description: `how many Notifications to show (default: ${DEFAULT_LISTED})`,
  })
  parseLines(value: string): number {
    return listLimit(value);
  }
}

@SubCommand({
  name: 'show',
  arguments: '<notification>',
  description:
    'Show a Notification: its message, its delivery attempts, and what stands in their way',
  argsDescription: NOTIFICATION,
})
export class NotificationsShowCommand extends PeroCommand {
  async run([notification]: string[]): Promise<void> {
    const id = notificationId(notification!);
    const { client } = await this.requireDaemon();
    console.log(
      formatNotificationDetails(await client.call('notifications.get', { id })),
    );
  }
}

interface RetryOptions {
  /** False with --no-wait. */
  wait?: boolean;
}

@SubCommand({
  name: 'retry',
  arguments: '<notification>',
  description:
    'Deliver a pending Notification now, or a failed one again with fresh attempts',
  argsDescription: NOTIFICATION,
})
export class NotificationsRetryCommand extends PeroCommand {
  async run([notification]: string[], options: RetryOptions): Promise<void> {
    const id = notificationId(notification!);
    const { client } = await this.requireDaemon();
    const queued = await client.call('notifications.retry', { id });
    if (options.wait === false) {
      console.log(
        `Notification ${id} is due now; Pero delivers it within seconds.`,
      );
      return;
    }
    console.error(`Delivering Notification ${id}…`);
    const after = await waitForAttempt(client, queued);
    if (after.status === 'delivered') {
      console.log(`Delivered Notification ${id}.`);
      return;
    }
    if (
      after.status === 'pending' &&
      (after.attempt === queued.attempt || after.delivering)
    ) {
      console.log(
        `Notification ${id} is still waiting for its attempt; pero notifications show ${id} tells how it went.`,
      );
      return;
    }
    const why = after.lastError ?? 'no reason was recorded';
    const next =
      after.status === 'pending' && after.nextAttemptAt !== null
        ? `; Pero tries again at ${localDateTime(new Date(after.nextAttemptAt))}`
        : '';
    throw new CliError(
      [
        `Could not deliver Notification ${id}: ${why}${next}`,
        ...deliveryProblems(after),
      ].join('\n'),
    );
  }

  @Option({
    flags: '--no-wait',
    description: 'make it due and return without waiting for the attempt',
  })
  parseNoWait(): false {
    return false;
  }
}

@Command({
  name: 'notifications',
  description:
    'List and show Notifications and how their delivery stands, and deliver them again',
  subCommands: [
    NotificationsListCommand,
    NotificationsShowCommand,
    NotificationsRetryCommand,
  ],
})
export class NotificationsCommand extends CommandRunner {
  // `ls` is the default subcommand, so this only runs if that changes.
  async run(): Promise<void> {
    this.command.help();
  }
}

/**
 * Asks the daemon about the Notification until an attempt after `queued`
 * has finished, or `ATTEMPT_WAIT_MS` has passed; returns it then.
 */
async function waitForAttempt(
  client: ControlClient,
  queued: NotificationDetails,
): Promise<NotificationDetails> {
  const deadline = Date.now() + ATTEMPT_WAIT_MS;
  let notification = queued;
  for (;;) {
    if (
      notification.status !== 'pending' ||
      (notification.attempt > queued.attempt && !notification.delivering)
    ) {
      return notification;
    }
    if (Date.now() >= deadline) return notification;
    await sleep(ATTEMPT_POLL_MS);
    notification = await client.call('notifications.get', { id: queued.id });
  }
}
