import type { MigrationInterface, QueryRunner } from 'typeorm';

/*
 * No CHECK constraint, for the reason RunSkippedCount gives: SQLite drops a
 * column only while no constraint names it. `workflowMaxAttemptsSchema`
 * bounds the value instead.
 */

/**
 * Adds `max_attempts`: how many times a run of a Workflow may start in all.
 * 1, the default, leaves an interrupted run for the owner to retry.
 */
export class WorkflowMaxAttempts1790621795251 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workflows" ADD COLUMN "max_attempts" integer NOT NULL DEFAULT (1)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workflows" DROP COLUMN "max_attempts"`,
    );
  }
}
