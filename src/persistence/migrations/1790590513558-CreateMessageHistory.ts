import type { MigrationInterface, QueryRunner } from 'typeorm';

/*
 * SQLite cannot drop a column that a CHECK constraint names, so `down`
 * rebuilds `settings` without `history_carryover`: create the new table,
 * copy the row, drop the old one, and rename. Nothing references
 * `settings`, so dropping it is safe whether or not foreign keys are on.
 */

const SETTINGS_COLUMNS =
  `"id", "default_provider", "provider_defaults", ` +
  `"default_working_directory", "shared_instructions", "timezone", ` +
  `"max_concurrent_runs", "created_at", "updated_at", "main_agent_id"`;

/**
 * Adds each Channel's message history and the `history_carryover` setting
 * that caps how much of it a replacing Session starts with.
 */
export class CreateMessageHistory1790590513558 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "messages" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"channel_id" integer NOT NULL, ` +
        `"agent_id" integer, ` +
        `"session_id" integer, ` +
        `"direction" text NOT NULL, ` +
        `"origin" text NOT NULL, ` +
        `"external_message_id" text NOT NULL, ` +
        `"sender_id" text, ` +
        `"text" text NOT NULL, ` +
        `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `CONSTRAINT "CHK_messages_agent_reply" CHECK ("origin" <> 'agent' OR ("agent_id" IS NOT NULL AND "session_id" IS NOT NULL)), ` +
        `CONSTRAINT "CHK_messages_origin_direction" CHECK (("direction" = 'in') = ("origin" = 'user')), ` +
        `CONSTRAINT "CHK_messages_origin" CHECK ("origin" IN ('user', 'agent', 'pero')), ` +
        `CONSTRAINT "CHK_messages_direction" CHECK ("direction" IN ('in', 'out')), ` +
        `CONSTRAINT "FK_messages_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION, ` +
        `CONSTRAINT "FK_messages_agent_id" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION, ` +
        `CONSTRAINT "FK_messages_session_id" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_channel_created_at" ON "messages" ("channel_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_created_at" ON "messages" ("created_at")`,
    );

    await queryRunner.query(
      `ALTER TABLE "settings" ADD COLUMN "history_carryover" integer NOT NULL DEFAULT (50) ` +
        `CONSTRAINT "CHK_settings_history_carryover" CHECK ("history_carryover" >= 0)`,
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

    await queryRunner.query(`DROP TABLE "messages"`);
  }
}
