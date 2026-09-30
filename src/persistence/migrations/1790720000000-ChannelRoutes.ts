import type { MigrationInterface, QueryRunner } from 'typeorm';

/*
 * Channels stop storing their Agent: in a workspace, notes' `topics` route
 * them on each message. Each Channel's Agent, by name, and whether it is
 * enabled move to `legacy_channel_agents`, which keeps a legacy data
 * directory answering as before and tells `pero migrate` which topics each
 * Agent claims, even after a newer daemon migrated the database.
 *
 * SQLite cannot drop a column that a foreign key names, so `up` rebuilds
 * `channels`; TypeORM turns foreign keys off before applying a migration.
 * It does not when reverting, and other tables reference `channels`, so
 * `down` gives the columns back with `ALTER TABLE`: `agent_id` nullable.
 */

const CHANNEL_COLUMNS =
  `"id", "integration_kind", "external_key", "address_json", "title", ` +
  `"created_at", "updated_at"`;

export class ChannelRoutes1790720000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "legacy_channel_agents" (` +
        `"channel_id" integer PRIMARY KEY NOT NULL, ` +
        `"agent_name" text NOT NULL, ` +
        `"enabled" boolean NOT NULL DEFAULT (1), ` +
        `CONSTRAINT "FK_legacy_channel_agents_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `INSERT INTO "legacy_channel_agents" ("channel_id", "agent_name", "enabled") ` +
        `SELECT "c"."id", "a"."name", "c"."enabled" ` +
        `FROM "channels" "c" JOIN "agents" "a" ON "a"."id" = "c"."agent_id"`,
    );

    await queryRunner.query(
      `CREATE TABLE "new_channels" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"integration_kind" text NOT NULL, ` +
        `"external_key" text NOT NULL, ` +
        `"address_json" text NOT NULL, ` +
        `"title" text, ` +
        `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updated_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `CONSTRAINT "CHK_channels_address_json" CHECK (json_valid("address_json")), ` +
        `CONSTRAINT "CHK_channels_integration_kind" CHECK ("integration_kind" IN ('telegram')))`,
    );
    await queryRunner.query(
      `INSERT INTO "new_channels" (${CHANNEL_COLUMNS}) ` +
        `SELECT ${CHANNEL_COLUMNS} FROM "channels"`,
    );
    await queryRunner.query(`DROP TABLE "channels"`);
    await queryRunner.query(`ALTER TABLE "new_channels" RENAME TO "channels"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_channels_key" ON "channels" ("integration_kind", "external_key")`,
    );

    const violations = (await queryRunner.query(
      `PRAGMA foreign_key_check`,
    )) as unknown[];
    if (violations.length > 0) {
      throw new Error(
        `Foreign key check failed after rebuilding channels: ${JSON.stringify(violations)}`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "channels" ADD COLUMN "agent_id" integer ` +
        `CONSTRAINT "FK_channels_agent_id" REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "channels" ADD COLUMN "enabled" boolean NOT NULL DEFAULT (1)`,
    );
    await queryRunner.query(
      `UPDATE "channels" SET ` +
        `"agent_id" = (SELECT "a"."id" FROM "legacy_channel_agents" "l" ` +
        `JOIN "agents" "a" ON "a"."name" = "l"."agent_name" ` +
        `WHERE "l"."channel_id" = "channels"."id"), ` +
        `"enabled" = COALESCE((SELECT "l"."enabled" FROM "legacy_channel_agents" "l" ` +
        `WHERE "l"."channel_id" = "channels"."id"), 1)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_channels_agent_id" ON "channels" ("agent_id")`,
    );
    await queryRunner.query(`DROP TABLE "legacy_channel_agents"`);
  }
}
