import type { MigrationInterface, QueryRunner } from 'typeorm';

/*
 * SQLite cannot drop a column that a CHECK constraint names, so `down`
 * rebuilds `settings` without `default_permissions`: create the new table,
 * copy the row, drop the old one, and rename. Nothing references
 * `settings`, so dropping it is safe whether or not foreign keys are on.
 */

const SETTINGS_COLUMNS =
  `"id", "default_provider", "provider_defaults", ` +
  `"default_working_directory", "shared_instructions", "timezone", ` +
  `"max_concurrent_runs", "created_at", "updated_at", "main_agent_id", ` +
  `"history_carryover"`;

/**
 * Adds the `default_permissions` setting, which says how new Agents' tools
 * are approved. Agents keep their `{}` tool policy, which reads as `ask`.
 */
export class DefaultPermissions1790602942841 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "settings" ADD COLUMN "default_permissions" text NOT NULL DEFAULT ('ask') ` +
        `CONSTRAINT "CHK_settings_default_permissions" CHECK ("default_permissions" IN ('ask', 'bypass'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "new_settings" (` +
        `"id" integer PRIMARY KEY NOT NULL, ` +
        `"default_provider" text NOT NULL DEFAULT ('claude'), ` +
        `"provider_defaults" text NOT NULL, ` +
        `"default_working_directory" text, ` +
        `"shared_instructions" text, ` +
        `"timezone" text NOT NULL, ` +
        `"max_concurrent_runs" integer NOT NULL DEFAULT (2), ` +
        `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updated_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"main_agent_id" integer, ` +
        `"history_carryover" integer NOT NULL DEFAULT (50), ` +
        `CONSTRAINT "CHK_settings_history_carryover" CHECK ("history_carryover" >= 0), ` +
        `CONSTRAINT "CHK_settings_max_concurrent_runs" CHECK ("max_concurrent_runs" >= 1), ` +
        `CONSTRAINT "CHK_settings_provider_defaults" CHECK (json_valid("provider_defaults")), ` +
        `CONSTRAINT "CHK_settings_default_provider" CHECK ("default_provider" IN ('claude', 'codex')), ` +
        `CONSTRAINT "CHK_settings_singleton" CHECK ("id" = 1), ` +
        `CONSTRAINT "FK_settings_main_agent_id" FOREIGN KEY ("main_agent_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `INSERT INTO "new_settings" (${SETTINGS_COLUMNS}) ` +
        `SELECT ${SETTINGS_COLUMNS} FROM "settings"`,
    );
    await queryRunner.query(`DROP TABLE "settings"`);
    await queryRunner.query(`ALTER TABLE "new_settings" RENAME TO "settings"`);
  }
}
