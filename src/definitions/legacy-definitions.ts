import {
  PROVIDERS,
  providerDefaultsSchema,
} from '../config/provider-options.js';
import { PERMISSION_MODES } from '../config/tool-policy.js';
import type { Defaults } from './definitions.js';

// What a legacy data directory still reads from its definition tables,
// which keep a `legacy_` name until it goes: the defaults in `settings`,
// renamed in plan step 8.5, and the chats in `allowed_chats`, renamed in
// 9.4. Read with plain SQL: no entity maps them any more.

/** Anything that runs SQL: a DataSource, an EntityManager. */
export interface Queryable {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

interface SettingsRow {
  default_provider: string;
  provider_defaults: string;
  default_working_directory: string | null;
  shared_instructions: string | null;
  history_carryover: number;
  history_retention_days: number | null;
  default_permissions: string;
  timezone: string;
  max_concurrent_runs: number;
}

/** The defaults a legacy data directory kept. */
export async function readLegacyDefaults(db: Queryable): Promise<Defaults> {
  return defaultsOf(await settingsRow(db));
}

/**
 * The folder a legacy data directory's Agents worked in by default, which
 * becomes the data folder of a `config.yaml` it lacks; null if none.
 */
export async function legacyDataFolder(db: Queryable): Promise<string | null> {
  const rows = (await db.query(
    `SELECT "default_working_directory" AS "folder" FROM "legacy_settings"`,
  )) as { folder: string | null }[];
  return rows[0]?.folder ?? null;
}

/** A chat the `allowed_chats` table allowed. */
export interface LegacyAllowedChat {
  id: number;
  chatKey: string;
  /** The chat's name as last seen; null if none was. */
  title: string | null;
}

/**
 * The Telegram chats the `allowed_chats` table of the database `db` still
 * allows, oldest first: those not yet moved into `config.yaml`.
 */
export async function readLegacyAllowedChats(
  db: Queryable,
): Promise<LegacyAllowedChat[]> {
  return (await db.query(
    `SELECT "id", "chat_key" AS "chatKey", "title" FROM "legacy_allowed_chats" ` +
      `WHERE "integration_kind" = 'telegram' ORDER BY "id"`,
  )) as LegacyAllowedChat[];
}

/** Deletes the chats `ids` from the `allowed_chats` table of `db`. */
export async function deleteLegacyAllowedChats(
  db: Queryable,
  ids: readonly number[],
): Promise<void> {
  if (ids.length === 0) return;
  await db.query(
    `DELETE FROM "legacy_allowed_chats" WHERE "id" IN (${ids.map(() => '?').join(', ')})`,
    [...ids],
  );
}

async function settingsRow(db: Queryable): Promise<SettingsRow> {
  const rows = (await db.query(
    `SELECT * FROM "legacy_settings" WHERE "id" = 1`,
  )) as SettingsRow[];
  const row = rows[0];
  if (row === undefined) throw new Error('The legacy settings row is missing');
  return row;
}

function defaultsOf(row: SettingsRow): Defaults {
  return {
    provider: oneOf(PROVIDERS, row.default_provider, 'default_provider'),
    providerDefaults: providerDefaultsSchema.parse(
      JSON.parse(row.provider_defaults),
    ),
    permissions: oneOf(
      PERMISSION_MODES,
      row.default_permissions,
      'default_permissions',
    ),
    timezone: row.timezone,
    historyCarryover: row.history_carryover,
    historyRetentionDays: row.history_retention_days,
    maxConcurrentRuns: row.max_concurrent_runs,
    dataFolder: row.default_working_directory,
    sharedInstructions: row.shared_instructions,
  };
}

/** `value`, which the table's checks keep among `values`. */
function oneOf<T extends string>(
  values: readonly T[],
  value: string,
  column: string,
): T {
  if (!(values as readonly string[]).includes(value)) {
    throw new Error(`Unknown ${column} ${value} in the legacy tables`);
  }
  return value as T;
}
