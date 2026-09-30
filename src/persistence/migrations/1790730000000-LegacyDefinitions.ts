import type { MigrationInterface, QueryRunner } from 'typeorm';

/*
 * Agents and the installation defaults come from notes: nothing reads the
 * `agents` and `settings` tables at runtime any more. They are renamed
 * rather than dropped, whole: a newer daemon may migrate a legacy
 * database before its owner runs `pero migrate`, which reads its Agents,
 * defaults, and main Agent from them, as `legacy_channel_agents` keeps
 * each Channel's Agent. They go with legacy data directories, after 0.2.0.
 *
 * SQLite renames the foreign key from `legacy_settings.main_agent_id`
 * along with the table it references.
 */
export class LegacyDefinitions1790730000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agents" RENAME TO "legacy_agents"`);
    await queryRunner.query(
      `ALTER TABLE "settings" RENAME TO "legacy_settings"`,
    );
    await checkForeignKeys(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "legacy_agents" RENAME TO "agents"`);
    await queryRunner.query(
      `ALTER TABLE "legacy_settings" RENAME TO "settings"`,
    );
    await checkForeignKeys(queryRunner);
  }
}

async function checkForeignKeys(queryRunner: QueryRunner): Promise<void> {
  const violations = (await queryRunner.query(
    `PRAGMA foreign_key_check`,
  )) as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `Foreign key check failed after renaming the definition tables: ${JSON.stringify(violations)}`,
    );
  }
}
