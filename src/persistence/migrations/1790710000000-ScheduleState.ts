import { createHash } from 'node:crypto';
import type { MigrationInterface, QueryRunner } from 'typeorm';

/*
 * A schedule's state moves from its Trigger row to `schedules`, keyed by
 * the Workflow's name and the schedule's fingerprint, so it outlives the
 * `triggers` table that notes replace. Each enabled schedule keeps its saved
 * times, copied as stored, so no run is missed or repeated. One without a
 * next run is left for the scheduler, which gives it one from now.
 */

interface ScheduleTriggerRow {
  id: number;
  workflow_name: string;
  config_json: string;
  timezone: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
}

interface ScheduleRow {
  workflow_name: string;
  fingerprint: string;
  next_run_at: string | null;
  last_run_at: string | null;
}

/**
 * `scheduleFingerprint` in src/triggers/schedule.ts as this migration
 * shipped, kept here so later changes there cannot change what it wrote.
 */
function fingerprint(cron: string, timezone: string): string {
  const spaced = cron.trim().split(/\s+/).join(' ');
  return createHash('sha256')
    .update(`${spaced}\n${timezone}`)
    .digest('hex')
    .slice(0, 16);
}

/** The cron expression in a schedule Trigger's `config_json`; null if none. */
function cronOf(configJson: string): string | null {
  const config = JSON.parse(configJson) as { cron?: unknown };
  return typeof config.cron === 'string' ? config.cron : null;
}

/** The schedule Triggers, with their Workflow's name and times. */
function scheduleTriggers(
  queryRunner: QueryRunner,
  where: string,
): Promise<ScheduleTriggerRow[]> {
  return queryRunner.query(
    `SELECT "t"."id", "w"."name" AS "workflow_name", "t"."config_json", ` +
      `"t"."timezone", "t"."next_run_at", "t"."last_run_at" ` +
      `FROM "triggers" "t" JOIN "workflows" "w" ON "w"."id" = "t"."workflow_id" ` +
      `WHERE "t"."kind" = 'schedule' ${where} ORDER BY "t"."id"`,
  ) as Promise<ScheduleTriggerRow[]>;
}

export class ScheduleState1790710000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "schedules" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"workflow_name" text NOT NULL, ` +
        `"fingerprint" text NOT NULL, ` +
        `"next_run_at" datetime, ` +
        `"last_run_at" datetime)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_schedules_workflow_fingerprint" ON "schedules" ("workflow_name", "fingerprint")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_schedules_next_run_at" ON "schedules" ("next_run_at")`,
    );

    const triggers = await scheduleTriggers(
      queryRunner,
      `AND "t"."enabled" = 1 AND "t"."next_run_at" IS NOT NULL`,
    );
    for (const trigger of triggers) {
      const cron = cronOf(trigger.config_json);
      if (cron === null || trigger.timezone === null) continue;
      await queryRunner.query(
        `INSERT OR IGNORE INTO "schedules" ` +
          `("workflow_name", "fingerprint", "next_run_at", "last_run_at") ` +
          `VALUES (?, ?, ?, ?)`,
        [
          trigger.workflow_name,
          fingerprint(cron, trigger.timezone),
          trigger.next_run_at,
          trigger.last_run_at,
        ],
      );
    }

    await queryRunner.query(`DROP INDEX "IDX_triggers_due"`);
    await queryRunner.query(`ALTER TABLE "triggers" DROP COLUMN "next_run_at"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "triggers" ADD COLUMN "next_run_at" datetime`,
    );
    const states = new Map(
      (
        (await queryRunner.query(
          `SELECT "workflow_name", "fingerprint", "next_run_at", "last_run_at" FROM "schedules"`,
        )) as ScheduleRow[]
      ).map((row) => [`${row.workflow_name}\n${row.fingerprint}`, row]),
    );
    for (const trigger of await scheduleTriggers(queryRunner, '')) {
      const cron = cronOf(trigger.config_json);
      if (cron === null || trigger.timezone === null) continue;
      const state = states.get(
        `${trigger.workflow_name}\n${fingerprint(cron, trigger.timezone)}`,
      );
      if (state === undefined) continue;
      await queryRunner.query(
        `UPDATE "triggers" SET "next_run_at" = ?, "last_run_at" = ? WHERE "id" = ?`,
        [state.next_run_at, state.last_run_at, trigger.id],
      );
    }
    await queryRunner.query(
      `CREATE INDEX "IDX_triggers_due" ON "triggers" ("enabled", "next_run_at")`,
    );
    await queryRunner.query(`DROP TABLE "schedules"`);
  }
}
