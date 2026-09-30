import type { MigrationInterface, QueryRunner } from 'typeorm';

/*
 * Workflows, their schedules, and their notification targets come from
 * notes, and the chats Pero serves from `config.yaml`: nothing reads the
 * `workflows`, `triggers`, `workflow_notification_targets`, and
 * `allowed_chats` tables at runtime any more. As in plan step 8.5, they
 * are renamed rather than dropped, whole: a newer daemon may migrate a
 * legacy database before its owner runs `pero migrate`, which reads its
 * Workflows from them, and the rows of `allowed_chats` still move into
 * `config.yaml` when it starts. They go with legacy data directories,
 * after 0.2.0.
 *
 * Runs stop naming their Trigger: `trigger_id` goes. SQLite cannot drop a
 * column that a foreign key names, so `up` rebuilds `workflow_runs` first,
 * so that renaming `triggers` doesn't carry the key over; TypeORM turns
 * foreign keys off before applying a migration. It does not when
 * reverting, and `notifications` references `workflow_runs`, so `down`
 * gives the column back with `ALTER TABLE`, empty.
 */

const RUN_COLUMNS =
  `"id", "workflow_name", "trigger_key", "status", "attempt", ` +
  `"execution_config_json", "created_at", "started_at", "finished_at", ` +
  `"result_json", "error_text", "skipped_count"`;

/** Each table, and the name it keeps for `pero migrate`. */
const RENAMES: [string, string][] = [
  ['workflows', 'legacy_workflows'],
  ['triggers', 'legacy_triggers'],
  ['workflow_notification_targets', 'legacy_workflow_notification_targets'],
  ['allowed_chats', 'legacy_allowed_chats'],
];

export class LegacyWorkflows1790740000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "new_workflow_runs" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"workflow_name" text NOT NULL, ` +
        `"trigger_key" text NOT NULL, ` +
        `"status" text NOT NULL DEFAULT ('pending'), ` +
        `"attempt" integer NOT NULL DEFAULT (1), ` +
        `"execution_config_json" text, ` +
        `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"started_at" datetime, ` +
        `"finished_at" datetime, ` +
        `"result_json" text, ` +
        `"error_text" text, ` +
        `"skipped_count" integer NOT NULL DEFAULT (0), ` +
        `CONSTRAINT "CHK_workflow_runs_result_json" CHECK (json_valid("result_json")), ` +
        `CONSTRAINT "CHK_workflow_runs_execution_config_json" CHECK (json_valid("execution_config_json")), ` +
        `CONSTRAINT "CHK_workflow_runs_attempt" CHECK ("attempt" >= 1), ` +
        `CONSTRAINT "CHK_workflow_runs_status" CHECK ("status" IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted')))`,
    );
    await queryRunner.query(
      `INSERT INTO "new_workflow_runs" (${RUN_COLUMNS}) ` +
        `SELECT ${RUN_COLUMNS} FROM "workflow_runs"`,
    );
    await queryRunner.query(`DROP TABLE "workflow_runs"`);
    await queryRunner.query(
      `ALTER TABLE "new_workflow_runs" RENAME TO "workflow_runs"`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workflow_runs_status" ON "workflow_runs" ("status", "created_at")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workflow_runs_trigger_key" ON "workflow_runs" ("workflow_name", "trigger_key")`,
    );

    for (const [table, legacy] of RENAMES) {
      await queryRunner.query(`ALTER TABLE "${table}" RENAME TO "${legacy}"`);
    }
    await checkForeignKeys(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, legacy] of RENAMES) {
      await queryRunner.query(`ALTER TABLE "${legacy}" RENAME TO "${table}"`);
    }
    await queryRunner.query(
      `ALTER TABLE "workflow_runs" ADD COLUMN "trigger_id" integer ` +
        `CONSTRAINT "FK_workflow_runs_trigger_id" REFERENCES "triggers" ("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workflow_runs_trigger_id" ON "workflow_runs" ("trigger_id")`,
    );
    await checkForeignKeys(queryRunner);
  }
}

async function checkForeignKeys(queryRunner: QueryRunner): Promise<void> {
  const violations = (await queryRunner.query(
    `PRAGMA foreign_key_check`,
  )) as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `Foreign key check failed after renaming the Workflow tables: ${JSON.stringify(violations)}`,
    );
  }
}
