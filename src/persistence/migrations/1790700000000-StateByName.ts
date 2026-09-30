import type { MigrationInterface, QueryRunner } from 'typeorm';

/*
 * SQLite cannot drop a column that a foreign key or CHECK constraint names,
 * so `up` rebuilds each table: create the new table, copy the rows, drop
 * the old one, and rename. TypeORM turns foreign keys off before a
 * migration's transaction when applying it, so dropping a table that others
 * reference leaves them alone. It does not when reverting, so `down`
 * rebuilds only `messages`, which nothing references, and gives the other
 * tables their ID columns back with `ALTER TABLE`. SQLite adds a NOT NULL
 * column only with a default, so those come back nullable, at the end.
 */

const SESSION_COLUMNS =
  `"id", "channel_id", "provider_session_id", "provider", ` +
  `"working_directory", "status", "created_at", "updated_at"`;

const MESSAGE_COLUMNS =
  `"id", "channel_id", "session_id", "direction", "origin", ` +
  `"external_message_id", "sender_id", "text", "created_at", "notification_id"`;

const RUN_COLUMNS =
  `"id", "trigger_id", "trigger_key", "status", "attempt", ` +
  `"execution_config_json", "created_at", "started_at", "finished_at", ` +
  `"result_json", "error_text", "skipped_count"`;

const WORKFLOW_COLUMNS =
  `"id", "name", "title", "input_template", "enabled", ` +
  `"concurrency_policy", "created_at", "updated_at", "max_attempts", ` +
  `"history_json"`;

/** The `messages` table, with the Agent by `agent` (`id` or `name`). */
function messagesTableSql(agent: 'id' | 'name'): string {
  const column = `agent_${agent}`;
  return (
    `CREATE TABLE "new_messages" (` +
    `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
    `"channel_id" integer NOT NULL, ` +
    `"${column}" ${agent === 'id' ? 'integer' : 'text'}, ` +
    `"session_id" integer, ` +
    `"direction" text NOT NULL, ` +
    `"origin" text NOT NULL, ` +
    `"external_message_id" text NOT NULL, ` +
    `"sender_id" text, ` +
    `"text" text NOT NULL, ` +
    `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
    `"notification_id" integer, ` +
    `CONSTRAINT "CHK_messages_agent_reply" CHECK ("origin" <> 'agent' OR ("${column}" IS NOT NULL AND "session_id" IS NOT NULL)), ` +
    `CONSTRAINT "CHK_messages_origin_direction" CHECK (("direction" = 'in') = ("origin" = 'user')), ` +
    `CONSTRAINT "CHK_messages_direction" CHECK ("direction" IN ('in', 'out')), ` +
    `CONSTRAINT "CHK_messages_origin" CHECK ("origin" IN ('user', 'agent', 'pero', 'workflow')), ` +
    `CONSTRAINT "CHK_messages_workflow" CHECK (("origin" = 'workflow') = ("notification_id" IS NOT NULL)), ` +
    `CONSTRAINT "FK_messages_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION, ` +
    (agent === 'id'
      ? `CONSTRAINT "FK_messages_agent_id" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION, `
      : '') +
    `CONSTRAINT "FK_messages_session_id" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION, ` +
    `CONSTRAINT "FK_messages_notification_id" FOREIGN KEY ("notification_id") REFERENCES "notifications" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION)`
  );
}

/**
 * State refers to Agents and Workflows by name instead of by row: Sessions
 * and messages name their Agent, Workflow Runs their Workflow. Workflows
 * name their Agent too, so they outlive the `agents` table. The foreign keys
 * to `agents` and `workflows` go.
 */
export class StateByName1790700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "new_workflows" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"name" text NOT NULL, ` +
        `"title" text, ` +
        `"agent_name" text NOT NULL, ` +
        `"input_template" text NOT NULL, ` +
        `"enabled" boolean NOT NULL DEFAULT (1), ` +
        `"concurrency_policy" text NOT NULL DEFAULT ('serial'), ` +
        `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updated_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"max_attempts" integer NOT NULL DEFAULT (1), ` +
        `"history_json" text, ` +
        `CONSTRAINT "CHK_workflows_name" CHECK ("name" <> '' AND length("name") <= 64 AND "name" NOT GLOB '*[^a-z0-9-]*' AND "name" NOT GLOB '-*' AND "name" NOT GLOB '*-' AND "name" NOT GLOB '*--*'), ` +
        `CONSTRAINT "CHK_workflows_concurrency_policy" CHECK ("concurrency_policy" IN ('serial')))`,
    );
    await queryRunner.query(
      `INSERT INTO "new_workflows" (${WORKFLOW_COLUMNS}, "agent_name") ` +
        `SELECT ${prefixed('w', WORKFLOW_COLUMNS)}, "a"."name" ` +
        `FROM "workflows" "w" JOIN "agents" "a" ON "a"."id" = "w"."agent_id"`,
    );
    await replaceTable(queryRunner, 'workflows');
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workflows_name" ON "workflows" ("name")`,
    );

    await queryRunner.query(
      `CREATE TABLE "new_workflow_runs" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"workflow_name" text NOT NULL, ` +
        `"trigger_id" integer, ` +
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
        `CONSTRAINT "CHK_workflow_runs_status" CHECK ("status" IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted')), ` +
        `CONSTRAINT "FK_workflow_runs_trigger_id" FOREIGN KEY ("trigger_id") REFERENCES "triggers" ("id") ON DELETE SET NULL ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `INSERT INTO "new_workflow_runs" (${RUN_COLUMNS}, "workflow_name") ` +
        `SELECT ${prefixed('r', RUN_COLUMNS)}, "w"."name" ` +
        `FROM "workflow_runs" "r" JOIN "workflows" "w" ON "w"."id" = "r"."workflow_id"`,
    );
    await replaceTable(queryRunner, 'workflow_runs');
    await createRunIndexes(queryRunner);

    await queryRunner.query(
      `CREATE TABLE "new_sessions" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"agent_name" text NOT NULL, ` +
        `"channel_id" integer NOT NULL, ` +
        `"provider_session_id" text, ` +
        `"provider" text NOT NULL, ` +
        `"working_directory" text NOT NULL, ` +
        `"status" text NOT NULL DEFAULT ('active'), ` +
        `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updated_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `CONSTRAINT "CHK_sessions_status" CHECK ("status" IN ('active', 'closed')), ` +
        `CONSTRAINT "CHK_sessions_provider" CHECK ("provider" IN ('claude', 'codex')), ` +
        `CONSTRAINT "FK_sessions_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `INSERT INTO "new_sessions" (${SESSION_COLUMNS}, "agent_name") ` +
        `SELECT ${prefixed('s', SESSION_COLUMNS)}, "a"."name" ` +
        `FROM "sessions" "s" JOIN "agents" "a" ON "a"."id" = "s"."agent_id"`,
    );
    await replaceTable(queryRunner, 'sessions');
    await createSessionIndexes(queryRunner, 'agent_name');

    await queryRunner.query(messagesTableSql('name'));
    await queryRunner.query(
      `INSERT INTO "new_messages" (${MESSAGE_COLUMNS}, "agent_name") ` +
        `SELECT ${prefixed('m', MESSAGE_COLUMNS)}, "a"."name" ` +
        `FROM "messages" "m" LEFT JOIN "agents" "a" ON "a"."id" = "m"."agent_id"`,
    );
    await replaceTable(queryRunner, 'messages');
    await createMessageIndexes(queryRunner);

    await checkForeignKeys(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(messagesTableSql('id'));
    await queryRunner.query(
      `INSERT INTO "new_messages" (${MESSAGE_COLUMNS}, "agent_id") ` +
        `SELECT ${prefixed('m', MESSAGE_COLUMNS)}, "a"."id" ` +
        `FROM "messages" "m" LEFT JOIN "agents" "a" ON "a"."name" = "m"."agent_name"`,
    );
    await replaceTable(queryRunner, 'messages');
    await createMessageIndexes(queryRunner);

    await queryRunner.query(`DROP INDEX "UQ_sessions_active"`);
    await queryRunner.query(`DROP INDEX "IDX_sessions_agent_name"`);
    await backToId(queryRunner, 'sessions', 'agent', 'agents');
    await createSessionIndexes(queryRunner, 'agent_id');

    await queryRunner.query(`DROP INDEX "UQ_workflow_runs_trigger_key"`);
    await backToId(queryRunner, 'workflow_runs', 'workflow', 'workflows');
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workflow_runs_trigger_key" ON "workflow_runs" ("workflow_id", "trigger_key")`,
    );

    await backToId(queryRunner, 'workflows', 'agent', 'agents');
    await queryRunner.query(
      `CREATE INDEX "IDX_workflows_agent_id" ON "workflows" ("agent_id")`,
    );
  }
}

/**
 * Gives `table` back its `<kind>_id` column, filled from `<kind>_name`
 * through `parent`, and drops `<kind>_name`.
 */
async function backToId(
  queryRunner: QueryRunner,
  table: string,
  kind: 'agent' | 'workflow',
  parent: string,
): Promise<void> {
  await queryRunner.query(
    `ALTER TABLE "${table}" ADD COLUMN "${kind}_id" integer ` +
      `CONSTRAINT "FK_${table}_${kind}_id" REFERENCES "${parent}" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
  );
  await queryRunner.query(
    `UPDATE "${table}" SET "${kind}_id" = ` +
      `(SELECT "id" FROM "${parent}" WHERE "name" = "${table}"."${kind}_name")`,
  );
  await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "${kind}_name"`);
}

/** Drops `table` and renames `new_<table>` to it; indexes go with the old. */
async function replaceTable(
  queryRunner: QueryRunner,
  table: string,
): Promise<void> {
  await queryRunner.query(`DROP TABLE "${table}"`);
  await queryRunner.query(`ALTER TABLE "new_${table}" RENAME TO "${table}"`);
}

async function createSessionIndexes(
  queryRunner: QueryRunner,
  agent: 'agent_id' | 'agent_name',
): Promise<void> {
  await queryRunner.query(
    `CREATE INDEX "IDX_sessions_${agent}" ON "sessions" ("${agent}")`,
  );
  await queryRunner.query(
    `CREATE UNIQUE INDEX "UQ_sessions_active" ON "sessions" ("channel_id", "${agent}") WHERE "status" = 'active'`,
  );
}

async function createRunIndexes(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(
    `CREATE INDEX "IDX_workflow_runs_trigger_id" ON "workflow_runs" ("trigger_id")`,
  );
  await queryRunner.query(
    `CREATE INDEX "IDX_workflow_runs_status" ON "workflow_runs" ("status", "created_at")`,
  );
  await queryRunner.query(
    `CREATE UNIQUE INDEX "UQ_workflow_runs_trigger_key" ON "workflow_runs" ("workflow_name", "trigger_key")`,
  );
}

async function createMessageIndexes(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(
    `CREATE INDEX "IDX_messages_channel_created_at" ON "messages" ("channel_id", "created_at")`,
  );
  await queryRunner.query(
    `CREATE INDEX "IDX_messages_created_at" ON "messages" ("created_at")`,
  );
  await queryRunner.query(
    `CREATE UNIQUE INDEX "UQ_messages_notification_id" ON "messages" ("notification_id")`,
  );
}

/** Foreign keys are off during migrations; prove the rebuild kept them valid. */
async function checkForeignKeys(queryRunner: QueryRunner): Promise<void> {
  const violations = (await queryRunner.query(
    `PRAGMA foreign_key_check`,
  )) as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `Foreign key check failed after rebuilding tables: ${JSON.stringify(violations)}`,
    );
  }
}

function prefixed(alias: string, columns: string): string {
  return columns
    .split(', ')
    .map((column) => `"${alias}".${column}`)
    .join(', ');
}
