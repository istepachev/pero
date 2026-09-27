import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataSourceOptions } from './data-source-options.js';
import { SETTINGS_ID, Settings } from './entities/settings.entity.js';
import { openDatabase } from './open-database.js';
import { inTransaction } from './transaction.js';

describe('inTransaction', () => {
  let tmp: string;
  let ds: DataSource;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-db-'));
    ds = await openDatabase(dataSourceOptions(join(tmp, 'pero.sqlite')));
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Reads the limit, yields, then writes it back plus one. */
  async function increment(run: typeof inTransaction) {
    return run(ds, async (manager) => {
      const repo = manager.getRepository(Settings);
      const { maxConcurrentRuns } = await repo.findOneByOrFail({
        id: SETTINGS_ID,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await repo.update(SETTINGS_ID, {
        maxConcurrentRuns: maxConcurrentRuns + 1,
      });
    });
  }

  it('shows why it exists: TypeORM overlaps transactions on SQLite', async () => {
    const plain: typeof inTransaction = (dataSource, work) =>
      dataSource.transaction(work);
    const results = await Promise.allSettled([
      increment(plain),
      increment(plain),
    ]);

    expect(results.some((result) => result.status === 'rejected')).toBe(true);
  });

  it('runs overlapping transactions one after another', async () => {
    await Promise.all([
      increment(inTransaction),
      increment(inTransaction),
      increment(inTransaction),
    ]);

    const settings = await ds
      .getRepository(Settings)
      .findOneByOrFail({ id: SETTINGS_ID });
    expect(settings.maxConcurrentRuns).toBe(5);
  });

  it('keeps going after a transaction fails, which rolls back', async () => {
    const failed = inTransaction(ds, async (manager) => {
      await manager
        .getRepository(Settings)
        .update(SETTINGS_ID, { timezone: 'Pacific/Chatham' });
      throw new Error('boom');
    });
    const next = increment(inTransaction);

    await expect(failed).rejects.toThrow('boom');
    await next;
    const settings = await ds
      .getRepository(Settings)
      .findOneByOrFail({ id: SETTINGS_ID });
    expect(settings.timezone).not.toBe('Pacific/Chatham');
    expect(settings.maxConcurrentRuns).toBe(3);
  });
});
