import type { MigrationInterface, QueryRunner } from 'typeorm';

/*
 * SQLite cannot drop a column that a CHECK constraint names, so `up`
 * rebuilds both tables: create the new table, copy the rows, drop the old
 * one, and rename. TypeORM turns foreign keys off before a migration's
 * transaction when applying it, so dropping `agents` leaves the tables that
 * reference it alone. It does not when reverting, so `down` only adds the
 * Agent column back and rebuilds `sessions`, which nothing references.
 */

const AGENT_COLUMNS =
  `"id", "name", "title", "provider", "instructions", "provider_options", ` +
  `"working_directory", "use_shared_instructions", ` +
  `"codex_skip_git_repo_check", "tool_policy_json", "enabled", ` +
  `"created_at", "updated_at"`;

const SESSION_COLUMNS =
  `"id", "agent_id", "channel_id", "provider_session_id", "status", ` +
  `"created_at", "updated_at"`;

const AGENT_CHECKS =
  `CONSTRAINT "CHK_agents_name" CHECK ("name" <> '' AND length("name") <= 64 AND "name" NOT GLOB '*[^a-z0-9-]*' AND "name" NOT GLOB '-*' AND "name" NOT GLOB '*-' AND "name" NOT GLOB '*--*'), ` +
  `CONSTRAINT "CHK_agents_tool_policy_json" CHECK (json_valid("tool_policy_json")), ` +
  `CONSTRAINT "CHK_agents_provider_options" CHECK (json_valid("provider_options")), ` +
  `CONSTRAINT "CHK_agents_provider" CHECK ("provider" IN ('claude', 'codex'))`;

const SESSION_FOREIGN_KEYS =
  `CONSTRAINT "FK_sessions_agent_id" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION, ` +
  `CONSTRAINT "FK_sessions_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION`;

/**
 * Replaces the Agent execution config version with what a Session needs to
 * resume: the provider and working directory it began with. Agents lose
 * `execution_config_version`; Sessions trade `agent_config_version` for
 * `provider` and `working_directory`.
 */
export class ResumeSessionsByProviderAndFolder1790578903382 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "new_agents" (${agentColumnsSql()}, ${AGENT_CHECKS})`,
    );
    await queryRunner.query(
      `INSERT INTO "new_agents" (${AGENT_COLUMNS}) ` +
        `SELECT ${AGENT_COLUMNS} FROM "agents"`,
    );
    await replaceTable(queryRunner, 'agents');
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_agents_name" ON "agents" ("name")`,
    );

    await queryRunner.query(
      `CREATE TABLE "new_sessions" (${sessionColumnsSql(true)}, ` +
        `CONSTRAINT "CHK_sessions_status" CHECK ("status" IN ('active', 'closed')), ` +
        `CONSTRAINT "CHK_sessions_provider" CHECK ("provider" IN ('claude', 'codex')), ` +
        `${SESSION_FOREIGN_KEYS})`,
    );
    // Existing Sessions take their Agent's current provider and folder. An
    // Agent with no folder at all gets one that never matches, so its next
    // turn starts afresh.
    await queryRunner.query(
      `INSERT INTO "new_sessions" (${SESSION_COLUMNS}, "provider", "working_directory") ` +
        `SELECT ${prefixed('s', SESSION_COLUMNS)}, "a"."provider", ` +
        `COALESCE("a"."working_directory", (SELECT "default_working_directory" FROM "settings" WHERE "id" = 1), '') ` +
        `FROM "sessions" "s" JOIN "agents" "a" ON "a"."id" = "s"."agent_id"`,
    );
    await replaceTable(queryRunner, 'sessions');
    await createSessionIndexes(queryRunner);
    await checkForeignKeys(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN "execution_config_version" integer NOT NULL DEFAULT (1) ` +
        `CONSTRAINT "CHK_agents_execution_config_version" CHECK ("execution_config_version" >= 1)`,
    );

    await queryRunner.query(
      `CREATE TABLE "new_sessions" (${sessionColumnsSql(false)}, ` +
        `CONSTRAINT "CHK_sessions_status" CHECK ("status" IN ('active', 'closed')), ` +
        `${SESSION_FOREIGN_KEYS})`,
    );
    // Every Agent is back at version 1, so every Session records version 1.
    await queryRunner.query(
      `INSERT INTO "new_sessions" (${SESSION_COLUMNS}, "agent_config_version") ` +
        `SELECT ${SESSION_COLUMNS}, 1 FROM "sessions"`,
    );
    await replaceTable(queryRunner, 'sessions');
    await createSessionIndexes(queryRunner);
  }
}

function agentColumnsSql(): string {
  return (
    `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
    `"name" text NOT NULL, ` +
    `"title" text, ` +
    `"provider" text NOT NULL, ` +
    `"instructions" text, ` +
    `"provider_options" text NOT NULL, ` +
    `"working_directory" text, ` +
    `"use_shared_instructions" boolean NOT NULL DEFAULT (1), ` +
    `"codex_skip_git_repo_check" boolean NOT NULL DEFAULT (0), ` +
    `"tool_policy_json" text NOT NULL, ` +
    `"enabled" boolean NOT NULL DEFAULT (1), ` +
    `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
    `"updated_at" datetime NOT NULL DEFAULT (datetime('now'))`
  );
}

function sessionColumnsSql(byProviderAndFolder: boolean): string {
  return (
    `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
    `"agent_id" integer NOT NULL, ` +
    `"channel_id" integer NOT NULL, ` +
    `"provider_session_id" text, ` +
    (byProviderAndFolder
      ? `"provider" text NOT NULL, "working_directory" text NOT NULL, `
      : `"agent_config_version" integer NOT NULL, `) +
    `"status" text NOT NULL DEFAULT ('active'), ` +
    `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
    `"updated_at" datetime NOT NULL DEFAULT (datetime('now'))`
  );
}

/** Drops `table` and renames `new_<table>` to it; indexes go with the old. */
async function replaceTable(
  queryRunner: QueryRunner,
  table: string,
): Promise<void> {
  await queryRunner.query(`DROP TABLE "${table}"`);
  await queryRunner.query(`ALTER TABLE "new_${table}" RENAME TO "${table}"`);
}

async function createSessionIndexes(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(
    `CREATE INDEX "IDX_sessions_agent_id" ON "sessions" ("agent_id")`,
  );
  await queryRunner.query(
    `CREATE UNIQUE INDEX "UQ_sessions_active" ON "sessions" ("channel_id", "agent_id") WHERE "status" = 'active'`,
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
