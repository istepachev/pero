import type { MigrationInterface, QueryRunner } from 'typeorm';

/*
 * No CHECK constraint: SQLite drops a column only while no constraint names
 * it, and rebuilding `workflow_runs` on revert, when TypeORM leaves foreign
 * keys on, would cascade to the Notifications that reference it.
 */

/**
 * Adds `skipped_count`: how many times a schedule came due for a run
 * without a run of their own, coalesced into it.
 */
export class RunSkippedCount1790620569391 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workflow_runs" ADD COLUMN "skipped_count" integer NOT NULL DEFAULT (0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workflow_runs" DROP COLUMN "skipped_count"`,
    );
  }
}
