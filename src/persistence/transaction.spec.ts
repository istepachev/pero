import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataSourceOptions } from './data-source-options.js';
import { WorkflowRun } from './entities/workflow-run.entity.js';
import { openDatabase } from './open-database.js';
import { inTransaction } from './transaction.js';

describe('inTransaction', () => {
  let tmp: string;
  let ds: DataSource;
  let id: number;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-db-'));
    ds = await openDatabase(dataSourceOptions(join(tmp, 'pero.sqlite')));
    ({ id } = await ds.getRepository(WorkflowRun).save({
      workflowName: 'brief',
      triggerKey: 'manual:1',
      attempt: 1,
    }));
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Reads the attempt, yields, then writes it back plus one. */
  async function increment(run: typeof inTransaction) {
    return run(ds, async (manager) => {
      const repo = manager.getRepository(WorkflowRun);
      const { attempt } = await repo.findOneByOrFail({ id });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await repo.update(id, { attempt: attempt + 1 });
    });
  }

  function workflowRun(): Promise<WorkflowRun> {
    return ds.getRepository(WorkflowRun).findOneByOrFail({ id });
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

    expect((await workflowRun()).attempt).toBe(4);
  });

  it('keeps going after a transaction fails, which rolls back', async () => {
    const failed = inTransaction(ds, async (manager) => {
      await manager
        .getRepository(WorkflowRun)
        .update(id, { errorText: 'Failed' });
      throw new Error('boom');
    });
    const next = increment(inTransaction);

    await expect(failed).rejects.toThrow('boom');
    await next;
    expect(await workflowRun()).toMatchObject({ errorText: null, attempt: 2 });
  });
});
