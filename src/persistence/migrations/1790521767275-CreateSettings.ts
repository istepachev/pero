import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Creates the singleton `settings` table and seeds its row. */
export class CreateSettings1790521767275 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "settings" (` +
        `"id" integer PRIMARY KEY NOT NULL, ` +
        `"default_provider" text NOT NULL DEFAULT ('claude'), ` +
        `"claude_model" text, ` +
        `"codex_model" text, ` +
        `"default_working_directory" text, ` +
        `"shared_instructions" text, ` +
        `"timezone" text NOT NULL, ` +
        `"max_concurrent_runs" integer NOT NULL DEFAULT (2), ` +
        `"shutdown_timeout_ms" integer NOT NULL DEFAULT (30000), ` +
        `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updated_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `CONSTRAINT "CHK_settings_shutdown_timeout_ms" CHECK ("shutdown_timeout_ms" >= 0), ` +
        `CONSTRAINT "CHK_settings_max_concurrent_runs" CHECK ("max_concurrent_runs" >= 1), ` +
        `CONSTRAINT "CHK_settings_default_provider" CHECK ("default_provider" IN ('claude', 'codex')), ` +
        `CONSTRAINT "CHK_settings_singleton" CHECK ("id" = 1))`,
    );
    // The first run happens on the host that runs Pero, so its zone is the
    // best initial guess; the owner can change it later.
    await queryRunner.query(
      `INSERT INTO "settings" ("id", "timezone") VALUES (1, ?)`,
      [hostTimeZone()],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "settings"`);
  }
}

function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
