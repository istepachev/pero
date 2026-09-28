import type { MigrationInterface, QueryRunner } from 'typeorm';

/*
 * TypeORM reads a foreign key's name only from a table-level constraint, and
 * SQLite adds a column's key only in column form, so `settings` is rebuilt:
 * create the new table, copy the row, drop the old one, and rename. Nothing
 * references `settings`, so dropping it is safe whether or not foreign keys
 * are on.
 */

const SETTINGS_COLUMNS =
  `"id", "default_provider", "provider_defaults", ` +
  `"default_working_directory", "shared_instructions", "timezone", ` +
  `"max_concurrent_runs", "created_at", "updated_at"`;

const SETTINGS_CHECKS =
  `CONSTRAINT "CHK_settings_max_concurrent_runs" CHECK ("max_concurrent_runs" >= 1), ` +
  `CONSTRAINT "CHK_settings_provider_defaults" CHECK (json_valid("provider_defaults")), ` +
  `CONSTRAINT "CHK_settings_default_provider" CHECK ("default_provider" IN ('claude', 'codex')), ` +
  `CONSTRAINT "CHK_settings_singleton" CHECK ("id" = 1)`;

/**
 * Adds the chat allowlist, a display title on Channels, and the main Agent
 * that primary Channels are assigned.
 */
export class AllowedChatsAndChannelTitles1790581676882 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "allowed_chats" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"integration_kind" text NOT NULL, ` +
        `"chat_key" text NOT NULL, ` +
        `"kind" text NOT NULL, ` +
        `"title" text, ` +
        `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updated_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `CONSTRAINT "CHK_allowed_chats_kind" CHECK ("kind" IN ('private', 'group')), ` +
        `CONSTRAINT "CHK_allowed_chats_integration_kind" CHECK ("integration_kind" IN ('telegram')))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_allowed_chats_key" ON "allowed_chats" ("integration_kind", "chat_key")`,
    );

    await queryRunner.query(`ALTER TABLE "channels" ADD COLUMN "title" text`);

    await queryRunner.query(
      `CREATE TABLE "new_settings" (${settingsColumnsSql(true)}, ` +
        `${SETTINGS_CHECKS}, ` +
        `CONSTRAINT "FK_settings_main_agent_id" FOREIGN KEY ("main_agent_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `INSERT INTO "new_settings" (${SETTINGS_COLUMNS}) ` +
        `SELECT ${SETTINGS_COLUMNS} FROM "settings"`,
    );
    await replaceTable(queryRunner, 'settings');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "new_settings" (${settingsColumnsSql(false)}, ${SETTINGS_CHECKS})`,
    );
    await queryRunner.query(
      `INSERT INTO "new_settings" (${SETTINGS_COLUMNS}) ` +
        `SELECT ${SETTINGS_COLUMNS} FROM "settings"`,
    );
    await replaceTable(queryRunner, 'settings');

    await queryRunner.query(`ALTER TABLE "channels" DROP COLUMN "title"`);
    await queryRunner.query(`DROP TABLE "allowed_chats"`);
  }
}

function settingsColumnsSql(withMainAgent: boolean): string {
  return (
    `"id" integer PRIMARY KEY NOT NULL, ` +
    `"default_provider" text NOT NULL DEFAULT ('claude'), ` +
    `"provider_defaults" text NOT NULL, ` +
    `"default_working_directory" text, ` +
    `"shared_instructions" text, ` +
    `"timezone" text NOT NULL, ` +
    `"max_concurrent_runs" integer NOT NULL DEFAULT (2), ` +
    `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
    `"updated_at" datetime NOT NULL DEFAULT (datetime('now'))` +
    (withMainAgent ? `, "main_agent_id" integer` : '')
  );
}

/** Drops `table` and renames `new_<table>` to it. */
async function replaceTable(
  queryRunner: QueryRunner,
  table: string,
): Promise<void> {
  await queryRunner.query(`DROP TABLE "${table}"`);
  await queryRunner.query(`ALTER TABLE "new_${table}" RENAME TO "${table}"`);
}
