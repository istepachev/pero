import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the domain tables: Agents, Channels, Sessions, Workflows,
 * Triggers, Workflow Runs, notification targets, Notifications, and inbound
 * updates, with their unique constraints, foreign keys, and indexes.
 */
export class CreateDomainTables1790523956072 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "agents" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"name" text NOT NULL, ` +
        `"provider" text NOT NULL, ` +
        `"instructions" text, ` +
        `"provider_options" text NOT NULL, ` +
        `"working_directory" text, ` +
        `"use_shared_instructions" boolean NOT NULL DEFAULT (1), ` +
        `"codex_skip_git_repo_check" boolean NOT NULL DEFAULT (0), ` +
        `"tool_policy_json" text NOT NULL, ` +
        `"execution_config_version" integer NOT NULL DEFAULT (1), ` +
        `"enabled" boolean NOT NULL DEFAULT (1), ` +
        `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updated_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `CONSTRAINT "CHK_agents_execution_config_version" CHECK ("execution_config_version" >= 1), ` +
        `CONSTRAINT "CHK_agents_tool_policy_json" CHECK (json_valid("tool_policy_json")), ` +
        `CONSTRAINT "CHK_agents_provider_options" CHECK (json_valid("provider_options")), ` +
        `CONSTRAINT "CHK_agents_provider" CHECK ("provider" IN ('claude', 'codex')))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_agents_name" ON "agents" ("name")`,
    );
    await queryRunner.query(
      `CREATE TABLE "channels" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"integration_kind" text NOT NULL, ` +
        `"external_key" text NOT NULL, ` +
        `"address_json" text NOT NULL, ` +
        `"agent_id" integer NOT NULL, ` +
        `"enabled" boolean NOT NULL DEFAULT (1), ` +
        `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updated_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `CONSTRAINT "CHK_channels_address_json" CHECK (json_valid("address_json")), ` +
        `CONSTRAINT "CHK_channels_integration_kind" CHECK ("integration_kind" IN ('telegram')), ` +
        `CONSTRAINT "FK_channels_agent_id" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_channels_agent_id" ON "channels" ("agent_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_channels_key" ON "channels" ("integration_kind", "external_key")`,
    );
    await queryRunner.query(
      `CREATE TABLE "sessions" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"agent_id" integer NOT NULL, ` +
        `"channel_id" integer NOT NULL, ` +
        `"provider_session_id" text, ` +
        `"agent_config_version" integer NOT NULL, ` +
        `"status" text NOT NULL DEFAULT ('active'), ` +
        `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updated_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `CONSTRAINT "CHK_sessions_status" CHECK ("status" IN ('active', 'closed')), ` +
        `CONSTRAINT "FK_sessions_agent_id" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION, ` +
        `CONSTRAINT "FK_sessions_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_sessions_agent_id" ON "sessions" ("agent_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_sessions_active" ON "sessions" ("channel_id", "agent_id") WHERE "status" = 'active'`,
    );
    await queryRunner.query(
      `CREATE TABLE "workflows" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"name" text NOT NULL, ` +
        `"agent_id" integer NOT NULL, ` +
        `"input_template" text NOT NULL, ` +
        `"enabled" boolean NOT NULL DEFAULT (1), ` +
        `"concurrency_policy" text NOT NULL DEFAULT ('serial'), ` +
        `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updated_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `CONSTRAINT "CHK_workflows_concurrency_policy" CHECK ("concurrency_policy" IN ('serial')), ` +
        `CONSTRAINT "FK_workflows_agent_id" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workflows_agent_id" ON "workflows" ("agent_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workflows_name" ON "workflows" ("name")`,
    );
    await queryRunner.query(
      `CREATE TABLE "triggers" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"workflow_id" integer NOT NULL, ` +
        `"kind" text NOT NULL, ` +
        `"config_json" text NOT NULL, ` +
        `"timezone" text, ` +
        `"next_run_at" datetime, ` +
        `"last_run_at" datetime, ` +
        `"enabled" boolean NOT NULL DEFAULT (1), ` +
        `CONSTRAINT "CHK_triggers_config_json" CHECK (json_valid("config_json")), ` +
        `CONSTRAINT "CHK_triggers_kind" CHECK ("kind" IN ('schedule', 'manual')), ` +
        `CONSTRAINT "FK_triggers_workflow_id" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_triggers_workflow_id" ON "triggers" ("workflow_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_triggers_due" ON "triggers" ("enabled", "next_run_at")`,
    );
    await queryRunner.query(
      `CREATE TABLE "workflow_runs" (` +
        `"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, ` +
        `"workflow_id" integer NOT NULL, ` +
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
        `CONSTRAINT "CHK_workflow_runs_result_json" CHECK (json_valid("result_json")), ` +
        `CONSTRAINT "CHK_workflow_runs_execution_config_json" CHECK (json_valid("execution_config_json")), ` +
        `CONSTRAINT "CHK_workflow_runs_attempt" CHECK ("attempt" >= 1), ` +
        `CONSTRAINT "CHK_workflow_runs_status" CHECK ("status" IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted')), ` +
        `CONSTRAINT "FK_workflow_runs_workflow_id" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION, ` +
        `CONSTRAINT "FK_workflow_runs_trigger_id" FOREIGN KEY ("trigger_id") REFERENCES "triggers" ("id") ON DELETE SET NULL ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workflow_runs_trigger_id" ON "workflow_runs" ("trigger_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workflow_runs_status" ON "workflow_runs" ("status", "created_at")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workflow_runs_trigger_key" ON "workflow_runs" ("workflow_id", "trigger_key")`,
    );
    await queryRunner.query(
      `CREATE TABLE "workflow_notification_targets" (` +
        `"workflow_id" integer NOT NULL, ` +
        `"channel_id" integer NOT NULL, ` +
        `CONSTRAINT "FK_workflow_notification_targets_workflow_id" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE CASCADE ON UPDATE NO ACTION, ` +
        `CONSTRAINT "FK_workflow_notification_targets_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE CASCADE ON UPDATE NO ACTION, ` +
        `PRIMARY KEY ("workflow_id", "channel_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workflow_notification_targets_channel_id" ON "workflow_notification_targets" ("channel_id")`,
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "inbound_updates"`);
    await queryRunner.query(`DROP TABLE "notifications"`);
    await queryRunner.query(`DROP TABLE "workflow_notification_targets"`);
    await queryRunner.query(`DROP TABLE "workflow_runs"`);
    await queryRunner.query(`DROP TABLE "triggers"`);
    await queryRunner.query(`DROP TABLE "workflows"`);
    await queryRunner.query(`DROP TABLE "sessions"`);
    await queryRunner.query(`DROP TABLE "channels"`);
    await queryRunner.query(`DROP TABLE "agents"`);
  }
}
