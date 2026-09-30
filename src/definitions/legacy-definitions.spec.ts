import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataSourceOptions } from '../persistence/data-source-options.js';
import { MIGRATIONS } from '../persistence/migrations/index.js';
import { openDatabase } from '../persistence/open-database.js';
import {
  deleteLegacyAllowedChats,
  legacyDataFolder,
  readLegacyAllowedChats,
  readLegacyDefaults,
} from './legacy-definitions.js';

describe('the legacy definitions', () => {
  let tmp: string;
  let database: string;
  let db: DataSource | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-legacy-'));
    database = join(tmp, 'pero.sqlite');
  });

  afterEach(async () => {
    if (db?.isInitialized) await db.destroy();
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * A database whose definitions `statements` wrote before plan steps 8.5
   * and 9.4 renamed their tables, migrated to the current schema.
   */
  async function legacy(statements: string[]): Promise<DataSource> {
    const old = await openDatabase({
      ...dataSourceOptions(database),
      migrations: MIGRATIONS.slice(0, -2),
    });
    for (const sql of statements) await old.query(sql);
    await old.destroy();
    db = await openDatabase(dataSourceOptions(database));
    return db;
  }

  it('reads the defaults, and the old default working directory', async () => {
    const db = await legacy([
      `UPDATE "settings" SET "default_provider" = 'codex', ` +
        `"provider_defaults" = '{"claude":{"model":"opus","effort":null}}', ` +
        `"default_working_directory" = '/home/owner/vault', ` +
        `"shared_instructions" = 'Be kind.', "default_permissions" = 'bypass', ` +
        `"timezone" = 'Europe/Berlin', "history_carryover" = 5, ` +
        `"history_retention_days" = 30, "max_concurrent_runs" = 4`,
    ]);

    expect(await readLegacyDefaults(db)).toEqual({
      provider: 'codex',
      providerDefaults: {
        claude: { model: 'opus', effort: null },
        codex: { model: null, effort: null },
      },
      permissions: 'bypass',
      timezone: 'Europe/Berlin',
      historyCarryover: 5,
      historyRetentionDays: 30,
      maxConcurrentRuns: 4,
      dataFolder: '/home/owner/vault',
      sharedInstructions: 'Be kind.',
    });
    expect(await legacyDataFolder(db)).toBe('/home/owner/vault');
  });

  it('has no data folder where none was set', async () => {
    expect(await legacyDataFolder(await legacy([]))).toBeNull();
  });

  it('reads the allowed chats, oldest first, and deletes them', async () => {
    const db = await legacy([
      `INSERT INTO "allowed_chats" ("integration_kind", "chat_key", "kind", "title") ` +
        `VALUES ('telegram', '-100222', 'group', 'Work'), ('telegram', '42', 'private', NULL)`,
    ]);

    const chats = await readLegacyAllowedChats(db);
    expect(chats).toEqual([
      { id: 1, chatKey: '-100222', title: 'Work' },
      { id: 2, chatKey: '42', title: null },
    ]);

    await deleteLegacyAllowedChats(db, [1]);
    expect(await readLegacyAllowedChats(db)).toEqual([
      { id: 2, chatKey: '42', title: null },
    ]);
    await deleteLegacyAllowedChats(db, []);
    expect(await readLegacyAllowedChats(db)).toHaveLength(1);
  });
});
