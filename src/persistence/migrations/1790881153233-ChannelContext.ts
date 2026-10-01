import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds where `/new` starts a Channel's context, and how full each Session's
 * context was after its latest turn.
 */
export class ChannelContext1790881153233 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "channels" ADD COLUMN "context_from_message_id" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "context_tokens" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "context_window" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP COLUMN "context_window"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP COLUMN "context_tokens"`,
    );
    await queryRunner.query(
      `ALTER TABLE "channels" DROP COLUMN "context_from_message_id"`,
    );
  }
}
