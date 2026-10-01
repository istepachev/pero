import { type EntityManager, LessThanOrEqual } from 'typeorm';
import { ScheduleState } from '../persistence/entities/schedule-state.entity.js';
import {
  nextOccurrence,
  type Schedule,
  scheduleFingerprint,
} from './schedule.js';

// The `schedules` rows: where each Workflow's schedule stands, one row per
// Workflow. The schedules themselves come from `Definitions`; a row holds
// its schedule's fingerprint, so a changed schedule replaces its times.

/** A schedule as the definitions hold it, with the Workflow it starts. */
export interface DefinedSchedule {
  workflow: string;
  schedule: Schedule;
}

/** What reconciling changed, for the log. */
export interface Reconciled {
  /** Schedules that got a row, with their first time; null if none comes. */
  added: { workflow: string; schedule: Schedule; nextRunAt: Date | null }[];
  /** Rows dropped because nothing defines their schedule any more. */
  dropped: { workflow: string; fingerprint: string }[];
  /** Schedules whose first time could not be computed. */
  failed: { workflow: string; schedule: Schedule; error: unknown }[];
}

/**
 * Makes the rows match the schedules `defined`: a Workflow whose schedule
 * has no row gets one, next due at its first time after `now`, a row
 * whose schedule changed starts afresh the same way, and a row whose
 * Workflow has no schedule any more is dropped. Overlapping calls are
 * safe: a row inserted twice is inserted once.
 */
export async function reconcileSchedulesWithin(
  manager: EntityManager,
  defined: readonly DefinedSchedule[],
  now: Date,
): Promise<Reconciled> {
  const repo = manager.getRepository(ScheduleState);
  const rows = await repo.find({
    select: { id: true, workflowName: true, fingerprint: true },
  });
  const existing = new Map(rows.map((row) => [row.workflowName, row]));
  const wanted = new Set<string>();
  const result: Reconciled = { added: [], dropped: [], failed: [] };

  for (const { workflow: name, schedule } of defined) {
    if (wanted.has(name)) continue;
    const fingerprint = scheduleFingerprint(schedule);
    const row = existing.get(name);
    if (row?.fingerprint === fingerprint) {
      wanted.add(name);
      continue;
    }
    let nextRunAt: Date | null;
    try {
      nextRunAt = nextOccurrence(schedule, now);
    } catch (error) {
      result.failed.push({ workflow: name, schedule, error });
      continue;
    }
    wanted.add(name);
    if (row !== undefined) {
      await repo.update(row.id, { fingerprint, nextRunAt, lastRunAt: null });
      result.added.push({ workflow: name, schedule, nextRunAt });
      continue;
    }
    const inserted = await repo
      .createQueryBuilder()
      .insert()
      .values({ workflowName: name, fingerprint, nextRunAt, lastRunAt: null })
      .orIgnore()
      .execute();
    if (inserted.identifiers[0]?.id !== undefined) {
      result.added.push({ workflow: name, schedule, nextRunAt });
    }
  }

  for (const row of rows) {
    if (wanted.has(row.workflowName)) continue;
    await repo.delete(row.id);
    result.dropped.push({
      workflow: row.workflowName,
      fingerprint: row.fingerprint,
    });
  }
  return result;
}

/** The rows due by `now`, soonest first, with their Workflow's name. */
export function dueSchedules(
  manager: EntityManager,
  now: Date,
): Promise<Pick<ScheduleState, 'id' | 'workflowName'>[]> {
  return manager.getRepository(ScheduleState).find({
    select: { id: true, workflowName: true },
    where: { nextRunAt: LessThanOrEqual(now) },
    order: { nextRunAt: 'ASC', id: 'ASC' },
  });
}

/** A schedule row that has come due. */
export interface DueSchedule {
  id: number;
  workflowName: string;
  fingerprint: string;
  /** The time it came due for. */
  due: Date;
}

/** Row `id`, read afresh, if it is still due by `now`; null otherwise. */
export async function dueScheduleWithin(
  manager: EntityManager,
  id: number,
  now: Date,
): Promise<DueSchedule | null> {
  const row = await manager.getRepository(ScheduleState).findOneBy({ id });
  if (row === null || row.nextRunAt === null || row.nextRunAt > now) {
    return null;
  }
  return {
    id,
    workflowName: row.workflowName,
    fingerprint: row.fingerprint,
    due: row.nextRunAt,
  };
}

/**
 * Moves row `id` on to `nextRunAt`, and records `lastRunAt` when it
 * started a run.
 */
export async function advanceScheduleWithin(
  manager: EntityManager,
  id: number,
  times: { nextRunAt: Date | null; lastRunAt?: Date },
): Promise<void> {
  await manager.getRepository(ScheduleState).update(id, times);
}

/** Drops row `id`, whose schedule is no longer defined. */
export async function dropScheduleWithin(
  manager: EntityManager,
  id: number,
): Promise<void> {
  await manager.getRepository(ScheduleState).delete(id);
}

/** The times a schedule row holds. */
export type ScheduleTimes = Pick<ScheduleState, 'nextRunAt' | 'lastRunAt'>;

/**
 * Every row, or those of the Workflow named `workflow`, by `stateKey`.
 */
export async function scheduleStatesWithin(
  manager: EntityManager,
  workflow?: string,
): Promise<Map<string, ScheduleTimes>> {
  const rows = await manager.getRepository(ScheduleState).find({
    where: workflow === undefined ? {} : { workflowName: workflow },
  });
  return new Map(
    rows.map((row) => [stateKey(row.workflowName, row.fingerprint), row]),
  );
}

/** The row of `schedule` of the Workflow named `workflow` in `states`. */
export function stateOf(
  states: ReadonlyMap<string, ScheduleTimes>,
  workflow: string,
  schedule: Schedule,
): ScheduleTimes | null {
  return states.get(stateKey(workflow, scheduleFingerprint(schedule))) ?? null;
}

function stateKey(workflow: string, fingerprint: string): string {
  return `${workflow}\n${fingerprint}`;
}
