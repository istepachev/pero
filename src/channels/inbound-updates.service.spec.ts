import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersistenceModule } from '../persistence/persistence.module.js';
import {
  INBOUND_UPDATE_PRUNE_INTERVAL_MS,
  InboundUpdates,
} from './inbound-updates.service.js';

describe('InboundUpdates', () => {
  let tmp: string;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let updates: InboundUpdates;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-updates-'));
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: join(tmp, 'pero.sqlite') }),
      ],
      providers: [InboundUpdates],
    }).compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    updates = moduleRef.get(InboundUpdates);
  });

  afterEach(async () => {
    await moduleRef.close();
    vi.useRealTimers();
    rmSync(tmp, { recursive: true, force: true });
  });

  function ids(): Promise<{ id: string; status: string }[]> {
    return ds.query(
      `SELECT "external_update_id" AS "id", "status" FROM "inbound_updates" ` +
        `ORDER BY "external_update_id"`,
    );
  }

  it('claims an update once and marks it processed', async () => {
    expect(await updates.claim('telegram', '1')).toBe(true);
    expect(await updates.claim('telegram', '1')).toBe(false);
    await updates.markProcessed('telegram', '1');

    expect(await updates.claim('telegram', '1')).toBe(false);
    expect(await ids()).toEqual([{ id: '1', status: 'processed' }]);
  });

  it('claims concurrent redeliveries once', async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() => updates.claim('telegram', '5')),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('forgets update IDs older than a week, at most once an hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await updates.claim('telegram', '1');
    const age = (days: number) =>
      ds.query(
        `INSERT INTO "inbound_updates" ("integration_kind", "external_update_id", "received_at") ` +
          `VALUES ('telegram', ?, datetime('now', ?))`,
        [`old-${days}`, `-${days} days`],
      );
    await age(8);
    await age(6);

    await updates.claim('telegram', '2');
    expect((await ids()).map((row) => row.id)).toContain('old-8');

    vi.setSystemTime(Date.now() + INBOUND_UPDATE_PRUNE_INTERVAL_MS);
    await updates.claim('telegram', '3');
    expect((await ids()).map((row) => row.id)).toEqual([
      '1',
      '2',
      '3',
      'old-6',
    ]);
  });
});
