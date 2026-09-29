import type { MigrationInterface, QueryRunner } from 'typeorm';

/*
 * No CHECK constraint, for the reason RunSkippedCount gives: SQLite drops a
 * column only while no constraint names it. `settingsUpdateSchema` bounds
 * the value instead.
 */

/**
 * Adds `history_retention_days`: how many days of message history to keep.
 * Null, the default, keeps all of it.
 */
export class HistoryRetention1790680000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "settings" ADD COLUMN "history_retention_days" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "settings" DROP COLUMN "history_retention_days"`,
    );
  }
}
