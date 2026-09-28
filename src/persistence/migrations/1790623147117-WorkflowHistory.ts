import type { MigrationInterface, QueryRunner } from 'typeorm';

/*
 * No CHECK constraint, for the reason RunSkippedCount gives: SQLite drops a
 * column only while no constraint names it. `workflowHistorySchema`
 * validates the JSON instead.
 */

/**
 * Adds `history_json`: the Channel history a Workflow's runs read as input.
 * Null, the default, reads none.
 */
export class WorkflowHistory1790623147117 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workflows" ADD COLUMN "history_json" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workflows" DROP COLUMN "history_json"`,
    );
  }
}
