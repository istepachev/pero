import type { MigrationInterface, QueryRunner } from 'typeorm';

/*
 * SQLite cannot change a CHECK constraint in place, so both directions
 * rebuild `messages`: create the new table, copy the rows, drop the old
 * one, rename, and recreate its indexes. Nothing references `messages`, so
 * dropping it is safe with foreign keys on. `last_error` has no CHECK, so
 * `down` drops it directly.
 */

const COLUMNS =
  `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
  `"channel_id" integer NOT NULL, ` +
  `"agent_id" integer, ` +
  `"session_id" integer, ` +
  `"direction" text NOT NULL, ` +
  `"origin" text NOT NULL, ` +
  `"external_message_id" text NOT NULL, ` +
  `"sender_id" text, ` +
  `"text" text NOT NULL, ` +
  `"created_at" datetime NOT NULL DEFAULT (datetime('now'))`;

const CONSTRAINTS =
  `CONSTRAINT "CHK_messages_agent_reply" CHECK ("origin" <> 'agent' OR ("agent_id" IS NOT NULL AND "session_id" IS NOT NULL)), ` +
  `CONSTRAINT "CHK_messages_origin_direction" CHECK (("direction" = 'in') = ("origin" = 'user')), ` +
  `CONSTRAINT "CHK_messages_direction" CHECK ("direction" IN ('in', 'out')), ` +
  `CONSTRAINT "FK_messages_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION, ` +
  `CONSTRAINT "FK_messages_agent_id" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION, ` +
  `CONSTRAINT "FK_messages_session_id" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION`;

const OLD_COLUMNS =
  `"id", "channel_id", "agent_id", "session_id", "direction", "origin", ` +
  `"external_message_id", "sender_id", "text", "created_at"`;

/**
 * Lets a delivered Notification join its Channel's history: `messages`
 * gains the `workflow` origin and `notification_id`, recorded once per
 * Notification, and `notifications` gains `last_error`, why its latest
 * delivery attempt failed.
 */
export class NotificationDelivery1790658397489 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notifications" ADD COLUMN "last_error" text`,
    );

    await queryRunner.query(
      `CREATE TABLE "new_messages" (${COLUMNS}, ` +
        `"notification_id" integer, ` +
        `${CONSTRAINTS}, ` +
        `CONSTRAINT "CHK_messages_origin" CHECK ("origin" IN ('user', 'agent', 'pero', 'workflow')), ` +
        `CONSTRAINT "CHK_messages_workflow" CHECK (("origin" = 'workflow') = ("notification_id" IS NOT NULL)), ` +
        `CONSTRAINT "FK_messages_notification_id" FOREIGN KEY ("notification_id") REFERENCES "notifications" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION)`,
    );
    await this.replaceMessages(queryRunner);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_messages_notification_id" ON "messages" ("notification_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "messages" WHERE "origin" = 'workflow'`,
    );
    await queryRunner.query(
      `CREATE TABLE "new_messages" (${COLUMNS}, ` +
        `${CONSTRAINTS}, ` +
        `CONSTRAINT "CHK_messages_origin" CHECK ("origin" IN ('user', 'agent', 'pero')))`,
    );
    await this.replaceMessages(queryRunner);

    await queryRunner.query(
      `ALTER TABLE "notifications" DROP COLUMN "last_error"`,
    );
  }

  /** Copies `messages` into `new_messages`, which then takes its place. */
  private async replaceMessages(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "new_messages" (${OLD_COLUMNS}) ` +
        `SELECT ${OLD_COLUMNS} FROM "messages"`,
    );
    await queryRunner.query(`DROP TABLE "messages"`);
    await queryRunner.query(`ALTER TABLE "new_messages" RENAME TO "messages"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_channel_created_at" ON "messages" ("channel_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_created_at" ON "messages" ("created_at")`,
    );
  }
}
