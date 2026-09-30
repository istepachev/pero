// Trigger keys: what started a run. A Workflow has one run per key.

const SCHEDULE_PREFIX = 'schedule:';

/** A run started by hand; each is its own occurrence. */
export function manualKey(id: string): string {
  return `manual:${id}`;
}

/** The run a schedule of Workflow `workflow` queues for its time `due`. */
export function scheduleKey(workflow: string, due: Date): string {
  return `${SCHEDULE_PREFIX}${workflow}:${due.toISOString()}`;
}

/** The `LIKE` pattern of every key `scheduleKey` makes. */
export const SCHEDULE_KEY_PATTERN = `${SCHEDULE_PREFIX}%`;

/** Whether a schedule queued the run with key `triggerKey`. */
export function isScheduled(triggerKey: string): boolean {
  return triggerKey.startsWith(SCHEDULE_PREFIX);
}
