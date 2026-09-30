import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  type DataSource,
  type EntityManager,
  IsNull,
  LessThanOrEqual,
} from 'typeorm';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
  parseInput,
} from '../common/errors.js';
import { type TriggerAdd, triggerAddSchema } from '../config/workflow-input.js';
import type { TriggerView } from '../control/protocol.js';
import {
  SETTINGS_ID,
  Settings,
} from '../persistence/entities/settings.entity.js';
import { Trigger } from '../persistence/entities/trigger.entity.js';
import { Workflow } from '../persistence/entities/workflow.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { findWorkflow } from '../workflows/workflows.service.js';
import { nextOccurrence, type Schedule } from './schedule.js';

/**
 * Adds, removes, and switches the Triggers that start Workflows. An enabled
 * schedule always has its next run; a disabled one has none.
 */
@Injectable()
export class TriggersService implements OnApplicationBootstrap {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Gives enabled schedules saved without a next run one, from now. */
  onApplicationBootstrap(): Promise<void> {
    return inTransaction(this.dataSource, async (manager) => {
      const triggers = manager.getRepository(Trigger);
      const unscheduled = await triggers.findBy({
        kind: 'schedule',
        enabled: true,
        nextRunAt: IsNull(),
      });
      const now = new Date();
      for (const trigger of unscheduled) {
        await triggers.update(trigger.id, {
          nextRunAt: nextRun(trigger, now),
        });
      }
    });
  }

  /** Every Trigger, or those of the Workflow named `workflow`, by ID. */
  list(workflow?: string): Promise<TriggerView[]> {
    return inTransaction(this.dataSource, async (manager) => {
      const workflowId =
        workflow === undefined
          ? undefined
          : (await findWorkflow(manager, workflow)).id;
      const triggers = await manager.getRepository(Trigger).find({
        where: workflowId === undefined ? {} : { workflowId },
        relations: { workflow: true },
        order: { id: 'ASC' },
      });
      // The foreign key guarantees the Workflow.
      return triggers.map((trigger) => triggerView(trigger, trigger.workflow!));
    });
  }

  /**
   * Adds a Trigger to a Workflow. A schedule without a time zone takes a
   * copy of the installation's, so changing that later leaves it alone. A
   * Workflow has at most one manual Trigger, and no two identical schedules.
   */
  async add(input: TriggerAdd): Promise<TriggerView> {
    const fields = parseInput(triggerAddSchema, input);
    return inTransaction(this.dataSource, async (manager) => {
      const workflow = await findWorkflow(manager, fields.workflow);
      const triggers = manager.getRepository(Trigger);
      const existing = await triggers.findBy({ workflowId: workflow.id });
      let trigger: Trigger;
      if (fields.kind === 'schedule') {
        const timezone =
          fields.timezone ??
          (
            await manager
              .getRepository(Settings)
              .findOneByOrFail({ id: SETTINGS_ID })
          ).timezone;
        const same = existing.find(
          (other) =>
            other.kind === 'schedule' &&
            other.config.cron === fields.cron &&
            other.timezone === timezone,
        );
        if (same !== undefined) {
          throw new ConflictError(
            `Workflow ${workflow.name} already has this schedule: Trigger ${same.id}`,
          );
        }
        const nextRunAt = nextOccurrence(
          { cron: fields.cron, timezone },
          new Date(),
        );
        if (nextRunAt === null) {
          throw new InvalidInputError(
            `cron: "${fields.cron}" never runs: no date matches it`,
          );
        }
        trigger = triggers.create({
          workflowId: workflow.id,
          kind: 'schedule',
          config: { cron: fields.cron },
          timezone,
          nextRunAt,
        });
      } else {
        const manual = existing.find((other) => other.kind === 'manual');
        if (manual !== undefined) {
          throw new ConflictError(
            `Workflow ${workflow.name} already has a manual Trigger: Trigger ${manual.id}`,
          );
        }
        trigger = triggers.create({
          workflowId: workflow.id,
          kind: 'manual',
          config: {},
          timezone: null,
        });
      }
      const { id } = await triggers.save(trigger);
      return triggerView(await triggers.findOneByOrFail({ id }), workflow);
    });
  }

  /** Removes Trigger `id`; the runs it created stay, with no Trigger. */
  remove(id: number): Promise<TriggerView> {
    return inTransaction(this.dataSource, async (manager) => {
      const { trigger, workflow } = await findTrigger(manager, id);
      await manager.getRepository(Trigger).delete(id);
      return triggerView(trigger, workflow);
    });
  }

  /**
   * Enables or disables Trigger `id`; a disabled one starts nothing. An
   * enabled schedule runs next at its first time from now, so the time it
   * spent disabled is never caught up.
   */
  setEnabled(id: number, enabled: boolean): Promise<TriggerView> {
    return inTransaction(this.dataSource, async (manager) => {
      const { trigger, workflow } = await findTrigger(manager, id);
      // Enabling an enabled schedule keeps its next run, even an overdue one.
      if (trigger.kind === 'schedule' && enabled !== trigger.enabled) {
        trigger.nextRunAt = enabled ? nextRun(trigger, new Date()) : null;
      }
      trigger.enabled = enabled;
      await manager
        .getRepository(Trigger)
        .update(id, { enabled, nextRunAt: trigger.nextRunAt });
      return triggerView(trigger, workflow);
    });
  }
}

/** Trigger `id` and its Workflow; `NotFoundError` if none. */
async function findTrigger(
  manager: EntityManager,
  id: number,
): Promise<{ trigger: Trigger; workflow: Workflow }> {
  const trigger = await manager.getRepository(Trigger).findOne({
    where: { id },
    relations: { workflow: true },
  });
  if (trigger === null) throw new NotFoundError(`No Trigger with ID ${id}`);
  // The foreign key guarantees the Workflow.
  return { trigger, workflow: trigger.workflow! };
}

/** A schedule Trigger's first time after `after`; `null` if it has none. */
function nextRun(trigger: Trigger, after: Date): Date | null {
  const { cron } = trigger.config;
  if (typeof cron !== 'string' || trigger.timezone === null) return null;
  return nextOccurrence({ cron, timezone: trigger.timezone }, after);
}

/** A Trigger as the CLI shows it, with the Workflow it starts. */
export function triggerView(
  trigger: Trigger,
  workflow: Pick<Workflow, 'name'>,
): TriggerView {
  const { cron } = trigger.config;
  return {
    id: trigger.id,
    workflow: workflow.name,
    kind: trigger.kind,
    cron: typeof cron === 'string' ? cron : null,
    timezone: trigger.timezone,
    nextRunAt: trigger.nextRunAt?.toISOString() ?? null,
    lastRunAt: trigger.lastRunAt?.toISOString() ?? null,
    enabled: trigger.enabled,
  };
}

// The Trigger rows that runtime code reads and advances, until plan step
// 7.3 moves schedule state into a table of its own and 9.1 lets any
// Workflow run by hand.

/** The Triggers of Workflow `workflowId`, named `workflow`, by ID. */
export async function triggerViewsWithin(
  manager: EntityManager,
  workflowId: number,
  workflow: string,
): Promise<TriggerView[]> {
  const triggers = await manager
    .getRepository(Trigger)
    .find({ where: { workflowId }, order: { id: 'ASC' } });
  return triggers.map((trigger) => triggerView(trigger, { name: workflow }));
}

/** How many Triggers each Workflow has, by Workflow ID. */
export async function triggerCountsWithin(
  manager: EntityManager,
): Promise<Map<number, number>> {
  const rows = await manager
    .getRepository(Trigger)
    .createQueryBuilder('t')
    .select('t.workflowId', 'workflowId')
    .addSelect('COUNT(*)', 'count')
    .groupBy('t.workflowId')
    .getRawMany<{ workflowId: number; count: number }>();
  return new Map(rows.map((row) => [row.workflowId, Number(row.count)]));
}

/** The manual Trigger of Workflow `workflowId`; null if it has none. */
export async function manualTriggerWithin(
  manager: EntityManager,
  workflowId: number,
): Promise<{ id: number; enabled: boolean } | null> {
  return manager.getRepository(Trigger).findOne({
    select: { id: true, enabled: true },
    where: { workflowId, kind: 'manual' },
  });
}

/** Records that Trigger `id` started a run at `at`. */
export async function markTriggerRunWithin(
  manager: EntityManager,
  id: number,
  at: Date,
): Promise<void> {
  await manager.getRepository(Trigger).update(id, { lastRunAt: at });
}

/** The enabled schedule Triggers due by `now`, soonest first. */
export async function dueScheduleIds(
  manager: EntityManager,
  now: Date,
): Promise<number[]> {
  const due = await manager.getRepository(Trigger).find({
    select: { id: true },
    where: { kind: 'schedule', enabled: true, nextRunAt: LessThanOrEqual(now) },
    order: { nextRunAt: 'ASC', id: 'ASC' },
  });
  return due.map(({ id }) => id);
}

/** A schedule Trigger that has come due. */
export interface DueSchedule {
  id: number;
  workflowId: number;
  /** The time it came due for. */
  due: Date;
  schedule: Schedule;
}

/**
 * Schedule Trigger `id`, read afresh, if it is still enabled and due by
 * `now`; null otherwise.
 */
export async function dueScheduleWithin(
  manager: EntityManager,
  id: number,
  now: Date,
): Promise<DueSchedule | null> {
  const trigger = await manager.getRepository(Trigger).findOneBy({ id });
  if (
    trigger === null ||
    trigger.kind !== 'schedule' ||
    !trigger.enabled ||
    trigger.nextRunAt === null ||
    trigger.nextRunAt > now
  ) {
    return null;
  }
  return {
    id,
    workflowId: trigger.workflowId,
    due: trigger.nextRunAt,
    schedule: {
      cron: String(trigger.config.cron),
      // Every schedule has one; see `TriggersService.add`.
      timezone: trigger.timezone!,
    },
  };
}

/**
 * Moves schedule Trigger `id` on to `nextRunAt`, and records `lastRunAt`
 * when it started a run.
 */
export async function advanceScheduleWithin(
  manager: EntityManager,
  id: number,
  times: { nextRunAt: Date | null; lastRunAt?: Date },
): Promise<void> {
  await manager.getRepository(Trigger).update(id, times);
}
