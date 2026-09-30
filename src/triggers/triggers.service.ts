import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
  parseInput,
} from '../common/errors.js';
import { type TriggerAdd, triggerAddSchema } from '../config/workflow-input.js';
import type { TriggerView } from '../control/protocol.js';
import { Definitions } from '../definitions/definitions.js';
import { SqliteDefinitions } from '../definitions/sqlite-definitions.js';
import { Trigger } from '../persistence/entities/trigger.entity.js';
import { Workflow } from '../persistence/entities/workflow.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import {
  reconcileSchedulesWithin,
  type ScheduleTimes,
  scheduleStatesWithin,
  stateOf,
} from '../scheduler/schedule-state.js';
import { findWorkflow } from '../workflows/workflows.service.js';
import {
  nextOccurrence,
  type Schedule,
  scheduleFingerprint,
} from './schedule.js';

/**
 * Adds, removes, and switches the Triggers that start Workflows. An enabled
 * schedule always has its saved times in `schedules`; a disabled one has
 * none. Each change is told to readers of the definitions once it commits.
 */
@Injectable()
export class TriggersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly definitions: SqliteDefinitions,
    /** Where the installation's time zone is: `Pero.md` in a workspace. */
    private readonly current: Definitions,
  ) {}

  /** Every Trigger, or those of the Workflow named `workflow`, by ID. */
  list(workflow?: string): Promise<TriggerView[]> {
    return inTransaction(this.dataSource, async (manager) => {
      const found =
        workflow === undefined
          ? undefined
          : await findWorkflow(manager, workflow);
      const triggers = await manager.getRepository(Trigger).find({
        where: found === undefined ? {} : { workflowId: found.id },
        relations: { workflow: true },
        order: { id: 'ASC' },
      });
      const states = await scheduleStatesWithin(manager, found?.name);
      // The foreign key guarantees the Workflow.
      return triggers.map((trigger) =>
        triggerView(trigger, trigger.workflow!, states),
      );
    });
  }

  /**
   * Adds a Trigger to a Workflow. A schedule without a time zone takes a
   * copy of the installation's, so changing that later leaves it alone. A
   * Workflow has at most one manual Trigger, and no two identical schedules.
   */
  async add(input: TriggerAdd): Promise<TriggerView> {
    const fields = parseInput(triggerAddSchema, input);
    const { timezone: installationZone } = await this.current.defaults();
    return this.committing(async (manager) => {
      const workflow = await findWorkflow(manager, fields.workflow);
      const triggers = manager.getRepository(Trigger);
      const existing = await triggers.findBy({ workflowId: workflow.id });
      let trigger: Trigger;
      if (fields.kind === 'schedule') {
        const timezone = fields.timezone ?? installationZone;
        // Spacing aside: two such schedules would share their saved times.
        const fingerprint = scheduleFingerprint({
          cron: fields.cron,
          timezone,
        });
        const same = existing.find((other) => {
          const schedule = scheduleOf(other);
          return (
            schedule !== null && scheduleFingerprint(schedule) === fingerprint
          );
        });
        if (same !== undefined) {
          throw new ConflictError(
            `Workflow ${workflow.name} already has this schedule: Trigger ${same.id}`,
          );
        }
        if (
          nextOccurrence({ cron: fields.cron, timezone }, new Date()) === null
        ) {
          throw new InvalidInputError(
            `cron: "${fields.cron}" never runs: no date matches it`,
          );
        }
        trigger = triggers.create({
          workflowId: workflow.id,
          kind: 'schedule',
          config: { cron: fields.cron },
          timezone,
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
      const states = await syncScheduleStatesWithin(manager, workflow);
      return triggerView(
        await triggers.findOneByOrFail({ id }),
        workflow,
        states,
      );
    });
  }

  /** Removes Trigger `id`; the runs it created stay, with no Trigger. */
  remove(id: number): Promise<TriggerView> {
    return this.committing(async (manager) => {
      const { trigger, workflow } = await findTrigger(manager, id);
      const states = await scheduleStatesWithin(manager, workflow.name);
      await manager.getRepository(Trigger).delete(id);
      await syncScheduleStatesWithin(manager, workflow);
      return triggerView(trigger, workflow, states);
    });
  }

  /**
   * Enables or disables Trigger `id`; a disabled one starts nothing. An
   * enabled schedule runs next at its first time from now, so the time it
   * spent disabled is never caught up.
   */
  setEnabled(id: number, enabled: boolean): Promise<TriggerView> {
    return this.committing(async (manager) => {
      const { trigger, workflow } = await findTrigger(manager, id);
      trigger.enabled = enabled;
      await manager.getRepository(Trigger).update(id, { enabled });
      // Enabling an enabled schedule keeps its next run, even an overdue one.
      const states = await syncScheduleStatesWithin(manager, workflow);
      return triggerView(trigger, workflow, states);
    });
  }

  /**
   * Runs `work` in a transaction, then tells readers of the definitions
   * once it has committed.
   */
  private async committing<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const result = await inTransaction(this.dataSource, work);
    this.definitions.changed();
    return result;
  }
}

/**
 * Brings the saved times of `workflow`'s schedules in line with its
 * enabled schedule Triggers, as the scheduler would on its next tick: a new
 * one runs next at its first time from now, and one removed or disabled
 * loses its times. Returns the times, by `scheduleStatesWithin`.
 */
async function syncScheduleStatesWithin(
  manager: EntityManager,
  workflow: Pick<Workflow, 'id' | 'name'>,
): Promise<Map<string, ScheduleTimes>> {
  const triggers = await manager.getRepository(Trigger).findBy({
    workflowId: workflow.id,
    kind: 'schedule',
    enabled: true,
  });
  const defined = triggers.flatMap((trigger) => {
    const schedule = scheduleOf(trigger);
    return schedule === null ? [] : [{ workflow: workflow.name, schedule }];
  });
  await reconcileSchedulesWithin(manager, defined, new Date(), workflow.name);
  return scheduleStatesWithin(manager, workflow.name);
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

/** A schedule Trigger's rule; null for a manual one. */
function scheduleOf(trigger: Trigger): Schedule | null {
  const { cron } = trigger.config;
  if (trigger.kind !== 'schedule' || typeof cron !== 'string') return null;
  // Every schedule has a time zone; see `TriggersService.add`.
  if (trigger.timezone === null) return null;
  return { cron, timezone: trigger.timezone };
}

/**
 * A Trigger as the CLI shows it, with the Workflow it starts. A schedule's
 * times come from `states`, those of its Workflow's schedules by
 * `scheduleStatesWithin`; a disabled one has none.
 */
export function triggerView(
  trigger: Trigger,
  workflow: Pick<Workflow, 'name'>,
  states: ReadonlyMap<string, ScheduleTimes>,
): TriggerView {
  const { cron } = trigger.config;
  const schedule = scheduleOf(trigger);
  const times: ScheduleTimes | null =
    schedule === null
      ? { nextRunAt: null, lastRunAt: trigger.lastRunAt }
      : trigger.enabled
        ? stateOf(states, workflow.name, schedule)
        : null;
  return {
    id: trigger.id,
    workflow: workflow.name,
    kind: trigger.kind,
    cron: typeof cron === 'string' ? cron : null,
    timezone: trigger.timezone,
    nextRunAt: times?.nextRunAt?.toISOString() ?? null,
    lastRunAt: times?.lastRunAt?.toISOString() ?? null,
    enabled: trigger.enabled,
  };
}

// The Trigger rows that runtime code reads, until plan step 9.1 lets any
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
  const states = await scheduleStatesWithin(manager, workflow);
  return triggers.map((trigger) =>
    triggerView(trigger, { name: workflow }, states),
  );
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
