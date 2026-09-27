import type { DataSource, EntityManager } from 'typeorm';

const queues = new WeakMap<DataSource, Promise<unknown>>();

/**
 * Runs `work` in a transaction once every earlier one on `dataSource` has
 * settled. SQLite is one connection here, and TypeORM 1.1 sends `BEGIN` on
 * it without waiting for an open transaction, so overlapping transactions
 * fail. Make every write go through this.
 */
export function inTransaction<T>(
  dataSource: DataSource,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const previous = queues.get(dataSource) ?? Promise.resolve();
  const result = previous.then(() => dataSource.transaction(work));
  queues.set(
    dataSource,
    result.catch(() => undefined),
  );
  return result;
}
