import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUSY_TIMEOUT_MS } from './data-source-options.js';
import { Settings } from './entities/settings.entity.js';
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

    // Throwaway tables: 1.4 adds the real ones and their foreign-key tests.
    await ds.query(`CREATE TABLE "parent" ("id" integer PRIMARY KEY)`);
    await ds.query(
      `CREATE TABLE "child" ("id" integer PRIMARY KEY, ` +
        `"parent_id" integer NOT NULL REFERENCES "parent" ("id"))`,
    );
    await expect(
      ds.query(`INSERT INTO "child" ("id", "parent_id") VALUES (1, 42)`),
    ).rejects.toMatchObject({
      driverError: { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' },
    });
  });

  it('seeds one settings row with the defaults', async () => {
    const ds = await start();

    const rows = await ds.getRepository(Settings).find();
    expect(rows).toEqual([
      {
        id: 1,
        defaultProvider: 'claude',
        providerDefaults: {
          claude: { model: null, effort: null },
          codex: { model: null, effort: null },
        },
        defaultWorkingDirectory: null,
        sharedInstructions: null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        maxConcurrentRuns: 2,
        shutdownTimeoutMs: 30_000,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
    ]);
  });

  it('rejects a second row, an unknown provider, and malformed JSON', async () => {
    const ds = await start();

    await expect(
      ds.query(
        `INSERT INTO "settings" ("id", "provider_defaults", "timezone") ` +
          `VALUES (2, '{}', 'UTC')`,
      ),
    ).rejects.toMatchObject({
      driverError: { code: 'SQLITE_CONSTRAINT_CHECK' },
    });
    await expect(
      ds.query(`UPDATE "settings" SET "default_provider" = 'gpt'`),
    ).rejects.toMatchObject({
      driverError: { code: 'SQLITE_CONSTRAINT_CHECK' },
    });
    await expect(
      ds.query(`UPDATE "settings" SET "provider_defaults" = '{'`),
    ).rejects.toMatchObject({
      driverError: { code: 'SQLITE_CONSTRAINT_CHECK' },
    });
  });

  it('validates provider defaults on write and read', async () => {
    const ds = await start();
    const repo = ds.getRepository(Settings);

    await repo.update(1, {
      providerDefaults: {
        claude: { model: 'claude-opus-5-5', effort: 'xhigh' },
        codex: { model: null, effort: null },
      },
    });
    expect((await repo.findOneByOrFail({ id: 1 })).providerDefaults).toEqual({
      claude: { model: 'claude-opus-5-5', effort: 'xhigh' },
      codex: { model: null, effort: null },
    });

    await expect(
      repo.update(1, {
        providerDefaults: {
          claude: { model: null, effort: 'minimal' as 'low' },
          codex: { model: null, effort: null },
        },
      }),
    ).rejects.toThrow(/effort/);

    // Valid JSON that the schema rejects fails loudly on read.
    await ds.query(
      `UPDATE "settings" SET "provider_defaults" = '{"claude":{"temp":1}}'`,
    );
    await expect(repo.findOneByOrFail({ id: 1 })).rejects.toThrow(/temp/);
  });

  it('treats a second startup as a no-op', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    let ds = await start();
    const applied = await appliedMigrations(ds);
    expect(log).toHaveBeenCalledWith(
      `Applied migration ${MIGRATIONS[0]!.name}`,
    );
    await ds.getRepository(Settings).update(1, { timezone: 'Europe/Berlin' });
    log.mockClear();

    ds = await restart();

    expect(log).not.toHaveBeenCalledWith(
      expect.stringMatching(/^Applied migration/),
    );
    expect(await appliedMigrations(ds)).toEqual(applied);
    const rows = await ds.getRepository(Settings).find();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.timezone).toBe('Europe/Berlin');
  });

  it('reverts cleanly and migrates again', async () => {
    const ds = await start();

    await ds.undoLastMigration({ transaction: 'each' });
    expect(
      await ds.query(
        `SELECT "name" FROM "sqlite_master" WHERE "name" = 'settings'`,
      ),
    ).toEqual([]);

    await ds.runMigrations({ transaction: 'each' });
    expect(await ds.getRepository(Settings).count()).toBe(1);
  });
});
