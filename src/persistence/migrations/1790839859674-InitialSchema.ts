import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the tables of state: Channels, inbound updates, Sessions,
 * Workflow Runs, Notifications, messages, and schedules, with their
 * unique constraints, checks, foreign keys, and indexes. Generated from the
 * entities, then ordered so each table names its foreign keys as it is
 * created, rather than being rebuilt to add them.
 */
export class InitialSchema1790839859674 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "channels" (` +
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
      `CREATE UNIQUE INDEX "UQ_channels_key" ON "channels" ("integration_kind", "external_key")`,
    );
    await queryRunner.query(
      `CREATE TABLE "inbound_updates" (` +
        `"integration_kind" text NOT NULL, ` +
        `"external_update_id" text NOT NULL, ` +
        `"received_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"status" text NOT NULL DEFAULT ('received'), ` +
        `CONSTRAINT "CHK_inbound_updates_status" CHECK ("status" IN ('received', 'processed')), ` +
        `CONSTRAINT "CHK_inbound_updates_integration_kind" CHECK ("integration_kind" IN ('telegram')), ` +
        `PRIMARY KEY ("integration_kind", "external_update_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_inbound_updates_received_at" ON "inbound_updates" ("received_at")`,
    );
    await queryRunner.query(
      `CREATE TABLE "sessions" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"agent_name" text NOT NULL, ` +
        `"channel_id" integer NOT NULL, ` +
        `"provider_session_id" text, ` +
        `"provider" text NOT NULL, ` +
        `"working_directory" text NOT NULL, ` +
        `"status" text NOT NULL DEFAULT ('active'), ` +
        `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updated_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `CONSTRAINT "CHK_sessions_provider" CHECK ("provider" IN ('claude', 'codex')), ` +
        `CONSTRAINT "CHK_sessions_status" CHECK ("status" IN ('active', 'closed')), ` +
        `CONSTRAINT "FK_sessions_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_sessions_agent_name" ON "sessions" ("agent_name")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_sessions_active" ON "sessions" ("channel_id", "agent_name") WHERE "status" = 'active'`,
    );
    await queryRunner.query(
      `CREATE TABLE "workflow_runs" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"workflow_name" text NOT NULL, ` +
        `"trigger_key" text NOT NULL, ` +
        `"status" text NOT NULL DEFAULT ('pending'), ` +
        `"attempt" integer NOT NULL DEFAULT (1), ` +
        `"skipped_count" integer NOT NULL DEFAULT (0), ` +
        `"execution_config_json" text, ` +
        `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"started_at" datetime, ` +
        `"finished_at" datetime, ` +
        `"result_json" text, ` +
        `"error_text" text, ` +
        `CONSTRAINT "CHK_workflow_runs_result_json" CHECK (json_valid("result_json")), ` +
        `CONSTRAINT "CHK_workflow_runs_execution_config_json" CHECK (json_valid("execution_config_json")), ` +
        `CONSTRAINT "CHK_workflow_runs_attempt" CHECK ("attempt" >= 1), ` +
        `CONSTRAINT "CHK_workflow_runs_status" CHECK ("status" IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted')))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workflow_runs_status" ON "workflow_runs" ("status", "created_at")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workflow_runs_trigger_key" ON "workflow_runs" ("workflow_name", "trigger_key")`,
    );
    await queryRunner.query(
      `CREATE TABLE "notifications" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"workflow_run_id" integer NOT NULL, ` +
        `"channel_id" integer NOT NULL, ` +
        `"status" text NOT NULL DEFAULT ('pending'), ` +
        `"payload" text NOT NULL, ` +
        `"attempt" integer NOT NULL DEFAULT (0), ` +
        `"next_attempt_at" datetime, ` +
        `"provider_message_id" text, ` +
        `"last_error" text, ` +
        `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updated_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `CONSTRAINT "CHK_notifications_attempt" CHECK ("attempt" >= 0), ` +
        `CONSTRAINT "CHK_notifications_payload" CHECK (json_valid("payload")), ` +
        `CONSTRAINT "CHK_notifications_status" CHECK ("status" IN ('pending', 'delivered', 'failed')), ` +
        `CONSTRAINT "FK_notifications_workflow_run_id" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs" ("id") ON DELETE CASCADE ON UPDATE NO ACTION, ` +
        `CONSTRAINT "FK_notifications_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notifications_channel_id" ON "notifications" ("channel_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notifications_delivery" ON "notifications" ("status", "next_attempt_at")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_notifications_target" ON "notifications" ("workflow_run_id", "channel_id")`,
    );
    await queryRunner.query(
      `CREATE TABLE "messages" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"channel_id" integer NOT NULL, ` +
        `"agent_name" text, ` +
        `"session_id" integer, ` +
        `"direction" text NOT NULL, ` +
        `"origin" text NOT NULL, ` +
        `"external_message_id" text NOT NULL, ` +
        `"sender_id" text, ` +
        `"text" text NOT NULL, ` +
        `"notification_id" integer, ` +
        `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `CONSTRAINT "CHK_messages_workflow" CHECK (("origin" = 'workflow') = ("notification_id" IS NOT NULL)), ` +
        `CONSTRAINT "CHK_messages_agent_reply" CHECK ("origin" <> 'agent' OR ("agent_name" IS NOT NULL AND "session_id" IS NOT NULL)), ` +
        `CONSTRAINT "CHK_messages_origin_direction" CHECK (("direction" = 'in') = ("origin" = 'user')), ` +
        `CONSTRAINT "CHK_messages_origin" CHECK ("origin" IN ('user', 'agent', 'pero', 'workflow')), ` +
        `CONSTRAINT "CHK_messages_direction" CHECK ("direction" IN ('in', 'out')), ` +
        `CONSTRAINT "FK_messages_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION, ` +
        `CONSTRAINT "FK_messages_session_id" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION, ` +
        `CONSTRAINT "FK_messages_notification_id" FOREIGN KEY ("notification_id") REFERENCES "notifications" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_messages_notification_id" ON "messages" ("notification_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_created_at" ON "messages" ("created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_channel_created_at" ON "messages" ("channel_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE TABLE "schedules" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"workflow_name" text NOT NULL, ` +
        `"fingerprint" text NOT NULL, ` +
        `"next_run_at" datetime, ` +
        `"last_run_at" datetime)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_schedules_next_run_at" ON "schedules" ("next_run_at")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_schedules_workflow_name" ON "schedules" ("workflow_name")`,
    );
  }

  /** Drops the tables, each before those it references; indexes go along. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'schedules',
      'messages',
      'notifications',
      'workflow_runs',
      'sessions',
      'inbound_updates',
      'channels',
    ]) {
      await queryRunner.query(`DROP TABLE "${table}"`);
    }
  }
}
