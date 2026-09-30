import {
  PROVIDERS,
  providerDefaultsSchema,
  providerOptionsSchema,
} from '../config/provider-options.js';
import { PERMISSION_MODES, toolPolicySchema } from '../config/tool-policy.js';
import type { AgentDefinition, Defaults } from './definitions.js';

// What a legacy data directory's `settings` and `agents` tables held, kept
// as `legacy_settings` and `legacy_agents` for `pero migrate` since plan
// step 8.5. Read with plain SQL: no entity maps them any more.

/** Anything that runs SQL: a DataSource, an EntityManager. */
export interface Queryable {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

/** The Agents, defaults, and main Agent of a legacy data directory. */
export interface LegacyDefinitions {
  defaults: Defaults;
  /** By name. */
  agents: AgentDefinition[];
  /** The name of the main Agent; null while none was chosen. */
  mainAgent: string | null;
}

interface SettingsRow {
  default_provider: string;
  provider_defaults: string;
  default_working_directory: string | null;
  shared_instructions: string | null;
  main_agent_id: number | null;
  history_carryover: number;
  history_retention_days: number | null;
  default_permissions: string;
  timezone: string;
  max_concurrent_runs: number;
}

interface AgentRow {
  id: number;
  name: string;
  title: string | null;
  provider: string;
  instructions: string | null;
  provider_options: string;
  working_directory: string | null;
  use_shared_instructions: number;
  codex_skip_git_repo_check: number;
  tool_policy_json: string;
  enabled: number;
}

/** What the legacy tables of the database `db` define. */
export async function readLegacyDefinitions(
  db: Queryable,
): Promise<LegacyDefinitions> {
  const settings = await settingsRow(db);
  const rows = (await db.query(
    `SELECT * FROM "legacy_agents" ORDER BY "name"`,
  )) as AgentRow[];
  return {
    defaults: defaultsOf(settings),
    agents: rows.map((row) => agentDefinition(row, settings)),
    mainAgent:
      rows.find((row) => row.id === settings.main_agent_id)?.name ?? null,
  };
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

/** The folder an Agent works in: its own, otherwise the shared default. */
function effectiveWorkingDirectory(
  agent: { workingDirectory: string | null },
  settings: { defaultWorkingDirectory: string | null },
): string {
  const folder = agent.workingDirectory ?? settings.defaultWorkingDirectory;
  // Creation and edits refused to follow an unset default, so this means a
  // row was changed by hand.
  if (folder === null) {
    throw new Error(
      'Agent follows the default working directory, which is unset',
    );
  }
  return folder;
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

function agentDefinition(
  row: AgentRow,
  settings: SettingsRow,
): AgentDefinition {
  return {
    name: row.name,
    title: row.title,
    provider: oneOf(PROVIDERS, row.provider, 'provider'),
    providerOptions: providerOptionsSchema.parse(
      JSON.parse(row.provider_options),
    ),
    permissions: toolPolicySchema.parse(JSON.parse(row.tool_policy_json))
      .permissions,
    workingDirectory: effectiveWorkingDirectory(
      { workingDirectory: row.working_directory },
      { defaultWorkingDirectory: settings.default_working_directory },
    ),
    ownWorkingDirectory: row.working_directory,
    instructions: row.instructions,
    sharedInstructions: row.use_shared_instructions !== 0,
    skipGitRepoCheck: row.codex_skip_git_repo_check !== 0,
    enabled: row.enabled !== 0,
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
