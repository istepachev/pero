import {
  PROVIDERS,
  providerDefaultsSchema,
  providerOptionsSchema,
} from '../config/provider-options.js';
import { PERMISSION_MODES, toolPolicySchema } from '../config/tool-policy.js';
import { workflowHistorySchema } from '../config/workflow-input.js';
import type { Schedule } from '../scheduler/schedule.js';
import type {
  AgentDefinition,
  Defaults,
  WorkflowDefinition,
} from './definitions.js';

// What a legacy data directory's definition tables held, kept for `pero
// migrate` under a `legacy_` name: `settings` and `agents` since plan step
// 8.5; `workflows`, `triggers`, `workflow_notification_targets`, and
// `allowed_chats` since 9.4. Read with plain SQL: no entity maps them any
// more.

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

/** A Trigger of a Workflow, whatever its kind and whether it is enabled. */
export interface LegacyTrigger {
  id: number;
  /** The name of its Workflow. */
  workflow: string;
  kind: 'schedule' | 'manual';
  /** A schedule's cron expression; null for a manual Trigger. */
  cron: string | null;
  timezone: string | null;
  enabled: boolean;
}

/** A chat the `allowed_chats` table allowed. */
export interface LegacyAllowedChat {
  id: number;
  chatKey: string;
  /** The chat's name as last seen; null if none was. */
  title: string | null;
}

interface WorkflowRow {
  id: number;
  name: string;
  title: string | null;
  agent_name: string;
  input_template: string;
  history_json: string | null;
  max_attempts: number;
  enabled: number;
}

interface TriggerRow {
  id: number;
  workflow: string;
  kind: string;
  config_json: string;
  timezone: string | null;
  enabled: number;
}

/**
 * The Workflows the legacy tables of the database `db` define, by name,
 * each with its notification targets and enabled schedules.
 */
export async function readLegacyWorkflows(
  db: Queryable,
): Promise<WorkflowDefinition[]> {
  const rows = (await db.query(
    `SELECT * FROM "legacy_workflows" ORDER BY "name"`,
  )) as WorkflowRow[];
  const targets = (await db.query(
    `SELECT "workflow_id", "channel_id" FROM "legacy_workflow_notification_targets" ` +
      `ORDER BY "workflow_id", "channel_id"`,
  )) as { workflow_id: number; channel_id: number }[];
  const triggers = await readLegacyTriggers(db);
  return rows.map((row) => ({
    name: row.name,
    title: row.title,
    agent: row.agent_name,
    input: row.input_template,
    history:
      row.history_json === null
        ? null
        : workflowHistorySchema.parse(JSON.parse(row.history_json)),
    targets: targets
      .filter((target) => target.workflow_id === row.id)
      .map((target) => target.channel_id),
    maxAttempts: row.max_attempts,
    schedules: triggers.flatMap((trigger): Schedule[] =>
      trigger.workflow === row.name &&
      trigger.kind === 'schedule' &&
      trigger.enabled &&
      // Every schedule has both; `pero triggers add` saw to it.
      trigger.cron !== null &&
      trigger.timezone !== null
        ? [{ cron: trigger.cron, timezone: trigger.timezone }]
        : [],
    ),
    enabled: row.enabled !== 0,
  }));
}

/** Every Trigger the legacy tables of the database `db` hold, oldest first. */
export async function readLegacyTriggers(
  db: Queryable,
): Promise<LegacyTrigger[]> {
  const rows = (await db.query(
    `SELECT "t"."id", "w"."name" AS "workflow", "t"."kind", "t"."config_json", ` +
      `"t"."timezone", "t"."enabled" FROM "legacy_triggers" "t" ` +
      `JOIN "legacy_workflows" "w" ON "w"."id" = "t"."workflow_id" ORDER BY "t"."id"`,
  )) as TriggerRow[];
  return rows.map((row) => {
    const config = JSON.parse(row.config_json) as { cron?: unknown };
    return {
      id: row.id,
      workflow: row.workflow,
      kind: oneOf(['schedule', 'manual'] as const, row.kind, 'kind'),
      cron: typeof config.cron === 'string' ? config.cron : null,
      timezone: row.timezone,
      enabled: row.enabled !== 0,
    };
  });
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
