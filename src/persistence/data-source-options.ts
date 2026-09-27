import type { BetterSqlite3DataSourceOptions } from 'typeorm/driver/better-sqlite3/BetterSqlite3DataSourceOptions.js';
import { ENTITIES } from './entities/index.js';
import { MIGRATIONS } from './migrations/index.js';

/** How long a connection waits for another writer's lock before failing. */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * TypeORM options for the SQLite database at `database`. The driver always
 * turns foreign keys on; migrations are applied by `openDatabase`, never by
 * schema synchronization.
 */
export function dataSourceOptions(
  database: string,
): BetterSqlite3DataSourceOptions {
  return {
    type: 'better-sqlite3',
    database,
    enableWAL: true,
    timeout: BUSY_TIMEOUT_MS,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    migrationsRun: false,
    migrationsTransactionMode: 'each',
    synchronize: false,
  };
}
