import { Logger } from '@nestjs/common';
import { DataSource, type DataSourceOptions } from 'typeorm';

const logger = new Logger('Persistence');

/**
 * Opens the database and applies pending migrations, each in its own
 * transaction. Resolves only once the schema is current; on failure the
 * connection is closed before the error propagates.
 */
export async function openDatabase(
  options: DataSourceOptions,
): Promise<DataSource> {
  const dataSource = await new DataSource(options).initialize();
  try {
    const applied = await dataSource.runMigrations({ transaction: 'each' });
    for (const migration of applied) {
      logger.log(`Applied migration ${migration.name}`);
    }
    return dataSource;
  } catch (error) {
    await dataSource.destroy();
    throw error;
  }
}
