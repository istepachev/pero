import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUSY_TIMEOUT_MS } from './data-source-options.js';
import { MIGRATIONS } from './migrations/index.js';
import { PersistenceModule } from './persistence.module.js';

describe('PersistenceModule', () => {
  let tmp: string;
  let database: string;
  let moduleRef: TestingModule | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-db-'));
    database = join(tmp, 'pero.sqlite');
  });

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function start(): Promise<DataSource> {
    moduleRef = await Test.createTestingModule({
      imports: [PersistenceModule.forRoot({ database })],
    }).compile();
    await moduleRef.init();
    return moduleRef.get<DataSource>(getDataSourceToken());
  }

  async function restart(): Promise<DataSource> {
    await moduleRef?.close();
    moduleRef = undefined;
    return start();
  }

  function appliedMigrations(ds: DataSource): Promise<{ name: string }[]> {
    return ds.query(`SELECT "name" FROM "migrations" ORDER BY "id"`);
  }

  it('migrates a fresh database', async () => {
    const ds = await start();

    expect(await appliedMigrations(ds)).toEqual(
      MIGRATIONS.map((migration) => ({ name: migration.name })),
    );
    expect(await ds.showMigrations()).toBe(false);
    expect(await ds.query('PRAGMA journal_mode')).toEqual([
      { journal_mode: 'wal' },
    ]);
    expect(await ds.query('PRAGMA busy_timeout')).toEqual([
      { timeout: BUSY_TIMEOUT_MS },
    ]);
  });

  it('matches the entities, so migrations and entities have not drifted', async () => {
    const ds = await start();

    const { upQueries } = await ds.driver.createSchemaBuilder().log();
    expect(upQueries.map((query) => query.query)).toEqual([]);
  });

  it('enforces foreign keys', async () => {
    const ds = await start();
    expect(await ds.query('PRAGMA foreign_keys')).toEqual([
      { foreign_keys: 1 },
    ]);

    await expect(
      ds.query(
        `INSERT INTO "sessions" ("agent_name", "channel_id", "provider", "working_directory") ` +
          `VALUES ('main', 42, 'claude', '/srv')`,
      ),
    ).rejects.toMatchObject({
      driverError: { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' },
    });
  });

  it('treats a second startup as a no-op', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    let ds = await start();
    const applied = await appliedMigrations(ds);
    expect(log).toHaveBeenCalledWith(
      `Applied migration ${MIGRATIONS[0]!.name}`,
    );
    await ds.query(
      `INSERT INTO "channels" ("integration_kind", "external_key", "address_json") ` +
        `VALUES ('telegram', '42', '{}')`,
    );
    log.mockClear();

    ds = await restart();

    expect(log).not.toHaveBeenCalledWith(
      expect.stringMatching(/^Applied migration/),
    );
    expect(await appliedMigrations(ds)).toEqual(applied);
    expect(await ds.query(`SELECT "external_key" FROM "channels"`)).toEqual([
      { external_key: '42' },
    ]);
  });

  it('reverts every migration cleanly and migrates again', async () => {
    const ds = await start();
    const tables = () =>
      ds.query(
        `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' ` +
          `ORDER BY "name"`,
      );
    const migrated = await tables();

    for (const _ of MIGRATIONS) {
      await ds.undoLastMigration({ transaction: 'each' });
    }
    // AUTOINCREMENT's sqlite_sequence cannot be dropped once created.
    expect(await tables()).toEqual([
      { name: 'migrations' },
      { name: 'sqlite_sequence' },
    ]);

    await ds.runMigrations({ transaction: 'each' });
    expect(await tables()).toEqual(migrated);
  });
});
