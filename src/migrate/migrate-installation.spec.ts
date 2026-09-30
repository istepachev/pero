import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allowChat,
  defaultHostConfig,
  editHostConfig,
  readHostConfig,
} from '../config/host-config.js';
import { acquireDaemonLock } from '../daemon/daemon-lock.js';
import {
  type Installation,
  readInstallation,
} from '../definitions/installation.js';
import { dataSourceOptions } from '../persistence/data-source-options.js';
import { MIGRATIONS } from '../persistence/migrations/index.js';
import { openDatabase } from '../persistence/open-database.js';
import { channelTopicLookup } from '../settings-notes/channel-topics.js';
import { loadSettings } from '../settings-files/load.js';
import type {
  SettingsSnapshot,
  TopicLookup,
} from '../settings-files/snapshot.js';
import { scheduleFingerprint } from '../triggers/schedule.js';
import { migrateInstallation } from './migrate-installation.js';

let tmp: string;
let source: string;
let vault: string;
let projects: string;
let workspace: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-migrate-')));
  source = join(tmp, 'legacy');
  vault = join(tmp, 'vault');
  projects = join(tmp, 'projects');
  workspace = join(tmp, 'workspace');
  for (const folder of [source, vault, projects]) mkdirSync(folder);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const agent = (
  name: string,
  title: string | null,
  provider: string,
  options: object,
  extra: Record<string, unknown> = {},
) => ({
  sql:
    `INSERT INTO "agents" ("name", "title", "provider", "instructions", "provider_options", "tool_policy_json", ` +
    `"working_directory", "use_shared_instructions", "codex_skip_git_repo_check", "enabled") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  params: [
    name,
    title,
    provider,
    extra.instructions ?? `You are ${name}.`,
    JSON.stringify(options),
    JSON.stringify({ permissions: extra.permissions ?? 'ask' }),
    extra.workingDirectory ?? null,
    extra.shared === false ? 0 : 1,
    extra.skipGit === true ? 1 : 0,
    extra.enabled === false ? 0 : 1,
  ],
});

const channel = (
  key: string,
  title: string | null,
  agentId: number,
  enabled = true,
) => ({
  sql:
    `INSERT INTO "channels" ("integration_kind", "external_key", "address_json", "agent_id", "title", "enabled") ` +
    `VALUES ('telegram', ?, ?, ?, ?, ?)`,
  params: [
    key,
    JSON.stringify(
      key.includes(':')
        ? {
            chatId: key.split(':')[0],
            messageThreadId: Number(key.split(':')[1]),
          }
        : { chatId: key },
    ),
    agentId,
    title,
    enabled ? 1 : 0,
  ],
});

const trigger = (
  workflowId: number,
  cron: string | null,
  timezone: string | null,
  enabled = true,
  nextRunAt: string | null = null,
) => ({
  sql:
    `INSERT INTO "triggers" ("workflow_id", "kind", "config_json", "timezone", "enabled", "next_run_at", "last_run_at") ` +
    `VALUES (?, ?, ?, ?, ?, ?, ?)`,
  params: [
    workflowId,
    cron === null ? 'manual' : 'schedule',
    JSON.stringify(cron === null ? {} : { cron }),
    timezone,
    enabled ? 1 : 0,
    nextRunAt,
    nextRunAt === null ? null : '2026-09-20 10:00:00.000',
  ],
});

/**
 * A legacy data directory as 0.1.0 left it: a database at its schema, a
 * `config.yaml` allowing two of the three chats (the third is still in
 * `allowed_chats`), the bot token, and a lock file. With `current`, a
 * later daemon has migrated the database since.
 */
async function legacyDataDir(
  options: {
    current?: boolean;
    extra?: { sql: string; params: unknown[] }[];
  } = {},
): Promise<void> {
  const database = join(source, 'pero.sqlite');
  const old = await openDatabase({
    ...dataSourceOptions(database),
    migrations: MIGRATIONS.slice(0, -3),
  });
  const rows = [
    agent('main', 'Main', 'claude', { model: 'opus', effort: 'high' }),
    // Onboarding named it after a topic whose name another Agent had.
    agent('health-2', 'Health', 'claude', { model: 'sonnet', effort: null }),
    agent(
      'coach',
      'Тренер',
      'codex',
      { model: 'gpt-5.5', effort: 'low' },
      {
        workingDirectory: projects,
        shared: false,
        skipGit: true,
        enabled: false,
        permissions: 'bypass',
      },
    ),
    {
      sql:
        `UPDATE "settings" SET "provider_defaults" = ?, "default_working_directory" = ?, "shared_instructions" = ?, ` +
        `"timezone" = 'Europe/Berlin', "history_carryover" = 20, "max_concurrent_runs" = 12, "main_agent_id" = 1`,
      params: [
        JSON.stringify({
          claude: { model: 'opus', effort: 'high' },
          codex: { model: null, effort: null },
        }),
        vault,
        '  Be brief.\n',
      ],
    },
    channel('-100111', 'Home', 1),
    channel('-100111:5', 'Health', 2),
    channel('-100222', 'Work', 1),
    channel('-100222:7', 'Health', 2),
    channel('-100222:9', 'Sport', 3, false),
    channel('42', 'Vit', 1),
    // A chat Pero no longer serves.
    channel('-100333:3', 'Health', 3),
    {
      sql:
        `INSERT INTO "workflows" ("name", "title", "agent_id", "input_template", "history_json", "max_attempts") ` +
        `VALUES ('weekly-report', 'Weekly Report', 2, 'Sum up the week.\n', ?, 3)`,
      params: [
        JSON.stringify({
          channels: [2, 4],
          messages: 'all',
          hours: 168,
          runWhenEmpty: true,
        }),
      ],
    },
    {
      sql: `INSERT INTO "workflows" ("name", "agent_id", "input_template") VALUES ('digest', 1, 'Digest.')`,
      params: [],
    },
    {
      sql: `INSERT INTO "workflows" ("name", "title", "agent_id", "input_template", "enabled") VALUES ('paused', 'Paused', 3, 'Wait.', 0)`,
      params: [],
    },
    trigger(1, '0 12 * * 0', 'Europe/Berlin', true, '2026-10-04 10:00:00.000'),
    trigger(1, '30 18 * * 1-5', 'UTC', true, '2026-09-30 18:30:00.000'),
    trigger(1, null, null),
    trigger(1, '0 7 * * *', 'Europe/Berlin', false),
    trigger(
      2,
      '*/15 9-17 * * 1-5',
      'Europe/Berlin',
      true,
      '2026-09-30 07:15:00.000',
    ),
    trigger(3, '0 8 1 * *', 'Europe/Berlin', false),
    ...[
      [1, 2],
      [1, 6],
      [2, 3],
      [2, 7],
    ].map(([workflowId, channelId]) => ({
      sql: `INSERT INTO "workflow_notification_targets" ("workflow_id", "channel_id") VALUES (?, ?)`,
      params: [workflowId, channelId],
    })),
    {
      sql: `INSERT INTO "allowed_chats" ("integration_kind", "chat_key", "kind", "title") VALUES ('telegram', '-100222', 'group', 'Work')`,
      params: [],
    },
    ...(options.extra ?? []),
  ];
  for (const { sql, params } of rows) await old.query(sql, params);
  await old.destroy();
  if (options.current) {
    await (await openDatabase(dataSourceOptions(database))).destroy();
  }

  const config = join(source, 'config.yaml');
  writeFileSync(config, defaultHostConfig({ data: vault }));
  editHostConfig(config, (document) => {
    allowChat(document, '-100111', 'Home');
    allowChat(document, '42', null);
  });
  mkdirSync(join(source, 'secrets'), { mode: 0o700 });
  writeFileSync(join(source, 'secrets', 'telegram-bot-token'), '123:abc\n', {
    mode: 0o600,
  });
  mkdirSync(join(source, 'run'));
  acquireDaemonLock(join(source, 'run', 'pero.lock'))!.release();
}

function migrate() {
  return migrateInstallation({
    source,
    workspace,
    homeDir: tmp,
    hostTimeZone: 'UTC',
  });
}

/** Every file under `dir` with its contents' hash and mode. */
function tree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[path.slice(dir.length)] =
      `${statSync(path).mode.toString(8)} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  }
  return files;
}

async function migratedInstallation(): Promise<Installation> {
  const dataSource = await openDatabase(
    dataSourceOptions(join(workspace, '.pero', 'pero.sqlite')),
  );
  try {
    return await readInstallation(dataSource);
  } finally {
    await dataSource.destroy();
  }
}

async function snapshotOf(lookup: TopicLookup): Promise<SettingsSnapshot> {
  const config = readHostConfig(join(workspace, '.pero', 'config.yaml'))!;
  const { snapshot } = await loadSettings({
    workspace,
    config,
    homeDir: tmp,
    hostTimeZone: 'UTC',
    topics: lookup,
  });
  return snapshot;
}

const trimmed = (text: string | null) => text?.trim() || null;

/** What the database defines, in the shape both sides are compared in. */
function fromDatabase(installation: Installation, allowed: Set<string>) {
  const { defaults } = installation;
  const served = (id: number) => {
    const found = installation.channels.find((channel) => channel.id === id)!;
    return allowed.has(found.key.split(':')[0]!);
  };
  return {
    defaults: {
      provider: defaults.provider,
      providerDefaults: defaults.providerDefaults,
      permissions: defaults.permissions,
      timezone: defaults.timezone,
      historyCarryover: defaults.historyCarryover,
      historyRetentionDays: defaults.historyRetentionDays,
      maxConcurrentRuns: Math.min(defaults.maxConcurrentRuns, 10),
      sharedInstructions: trimmed(defaults.sharedInstructions),
    },
    mainAgent: installation.mainAgent,
    agents: installation.agents.map((each) => ({
      name: each.name,
      provider: each.provider,
      // An Agent without its own model or effort takes Pero.md's now.
      model:
        each.providerOptions.model ??
        defaults.providerDefaults[each.provider].model,
      effort:
        each.providerOptions.effort ??
        defaults.providerDefaults[each.provider].effort,
      permissions: each.permissions,
      workingDirectory: each.workingDirectory,
      instructions: trimmed(each.instructions),
      sharedInstructions: each.sharedInstructions,
      skipGitRepoCheck: each.skipGitRepoCheck,
      enabled: each.enabled,
    })),
    topics: Object.fromEntries(
      installation.channels
        .filter(
          (each) =>
            each.key.includes(':') &&
            each.title !== null &&
            allowed.has(each.key.split(':')[0]!),
        )
        .map((each) => [each.title!.toLowerCase(), each.agent]),
    ),
    workflows: installation.workflows.map((each) => ({
      name: each.name,
      agent: each.agent,
      input: trimmed(each.input),
      targets: each.targets.filter(served),
      history:
        each.history === null
          ? null
          : {
              ...each.history,
              channels:
                each.history.channels === 'all'
                  ? 'all'
                  : each.history.channels.filter(served),
            },
      maxAttempts: each.maxAttempts,
      schedules: each.schedules,
      enabled: each.enabled,
    })),
  };
}

/** What the notes define, in the same shape. */
function fromNotes(snapshot: SettingsSnapshot, lookup: TopicLookup) {
  const id = (ref: string | number) => {
    const found = lookup.resolve(ref);
    if (found.kind !== 'ok')
      throw new Error(`${ref} resolves to ${found.kind}`);
    return found.channel.id;
  };
  const ids = (refs: readonly (string | number)[]) =>
    refs.map(id).sort((a, b) => a - b);
  const { defaults } = snapshot;
  return {
    defaults: {
      provider: defaults.provider,
      providerDefaults: defaults.providerDefaults,
      permissions: defaults.permissions,
      timezone: defaults.timezone,
      historyCarryover: defaults.historyCarryover,
      historyRetentionDays: defaults.historyRetentionDays,
      maxConcurrentRuns: defaults.maxConcurrentRuns,
      sharedInstructions: snapshot.sharedInstructions,
    },
    mainAgent: snapshot.mainAgent,
    agents: [...snapshot.agents.values()]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((each) => ({
        name: each.name,
        provider: each.provider,
        model: each.model,
        effort: each.effort,
        permissions: each.permissions,
        workingDirectory: each.workingDirectory,
        instructions: each.instructions,
        sharedInstructions: each.sharedInstructions,
        skipGitRepoCheck: each.skipGitRepoCheck,
        enabled: each.enabled,
      })),
    topics: Object.fromEntries(snapshot.topicClaims),
    workflows: [...snapshot.workflows.values()]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((each) => ({
        name: each.name,
        agent: each.agent,
        input: each.input,
        targets: ids(each.channels),
        history:
          each.history === null
            ? null
            : {
                ...each.history,
                channels:
                  each.history.channels === 'all'
                    ? 'all'
                    : ids(each.history.channels),
              },
        maxAttempts: each.maxAttempts,
        schedules: each.schedule === null ? [] : [each.schedule],
        enabled: each.enabled,
      })),
  };
}

describe('migrateInstallation', () => {
  it.each([
    ['as 0.1.0 left it', false],
    ['migrated by a later daemon', true],
  ])('writes notes that describe the database %s', async (_, current) => {
    await legacyDataDir({ current });
    const before = tree(source);

    const result = await migrate();

    expect(tree(source)).toEqual(before);
    expect(result.check.problems).toEqual([]);
    expect(result.check.topicsChecked).toBe(true);

    const installation = await migratedInstallation();
    const config = readHostConfig(join(workspace, '.pero', 'config.yaml'))!;
    const allowed = new Set(config.allowedChats.map((chat) => chat.chatKey));
    expect([...allowed].sort()).toEqual(['-100111', '-100222', '42']);
    const lookup = channelTopicLookup(
      installation.channels
        .filter((each) => allowed.has(each.key.split(':')[0]!))
        .map(({ id, key, title }) => ({ id, key, title })),
    );
    const snapshot = await snapshotOf(lookup);
    expect(snapshot.errors).toEqual([]);
    expect(fromNotes(snapshot, lookup)).toEqual(
      fromDatabase(installation, allowed),
    );
  });

  it('writes each note as the owner would, keeping names', async () => {
    await legacyDataDir();
    const result = await migrate();
    const settings = join(vault, 'Settings');
    const note = (path: string) => readFileSync(join(settings, path), 'utf8');

    expect(readdirSync(join(settings, 'Agents')).sort()).toEqual([
      'Main.md',
      '_Template.md',
      'coach.md',
      'health-2.md',
    ]);
    expect(readdirSync(join(settings, 'Workflows')).sort()).toEqual([
      'Paused.md',
      'Weekly Report 1.md',
      'Weekly Report 2.md',
      'digest.md',
    ]);
    expect(note('Pero.md')).toBe(
      [
        '---',
        'claude-model: opus',
        'claude-effort: high',
        'timezone: Europe/Berlin',
        'history-carryover: 20',
        'max-concurrent-runs: 10',
        '---',
        'Be brief.',
        '',
      ].join('\n'),
    );
    expect(note('Agents/health-2.md')).toBe(
      [
        '---',
        'topics:',
        '  - Health',
        'model: sonnet',
        '---',
        'You are health-2.',
        '',
      ].join('\n'),
    );
    expect(note('Agents/coach.md')).toBe(
      [
        '---',
        'topics:',
        '  - Sport',
        'provider: codex',
        'model: gpt-5.5',
        'effort: low',
        'permissions: bypass',
        `working-directory: ${projects}`,
        'shared-instructions: false',
        'skip-git-repo-check: true',
        'enabled: false',
        '---',
        'You are coach.',
        '',
      ].join('\n'),
    );
    expect(note('Workflows/Weekly Report 1.md')).toBe(
      [
        '---',
        'agent: health-2',
        'channel:',
        '  - Home/Health',
        '  - 6',
        'day: sunday',
        'hour: 12',
        'history: true',
        'history-channels:',
        '  - Home/Health',
        '  - Work/Health',
        'history-messages: all',
        'history-hours: 168',
        'run-when-empty: true',
        'max-attempts: 3',
        '---',
        'Sum up the week.',
        '',
      ].join('\n'),
    );
    expect(note('Workflows/Weekly Report 2.md')).toContain(
      'day: weekdays\nhour: 18\nminute: 30\ntimezone: UTC\n',
    );
    expect(note('Workflows/digest.md')).toContain(
      'agent: Main\nchannel:\n  - Work/General\ncron: "*/15 9-17 * * 1-5"\n',
    );
    expect(note('Workflows/Paused.md')).toBe(
      [
        '---',
        'agent: coach',
        'trigger: manual',
        'cron: 0 8 1 * *',
        'enabled: false',
        '---',
        'Wait.',
        '',
      ].join('\n'),
    );

    expect(result.notices).toEqual([
      'max-concurrent-runs was 12; Pero.md allows at most 10, so it is 10 now.',
      'Topic Work/Sport was disabled; coach answers it now. Disable the Agent, or take the topic out of its topics, to silence it.',
      'Agent health-2 had no effort of its own, so its provider chose; it takes claude-effort from Pero.md now: high.',
      "Workflow digest named Channel 7 in its notifications, in a chat Pero doesn't serve; it is left out.",
      'Workflow weekly-report had a disabled schedule, 0 7 * * * in Europe/Berlin; a note has no place for it, so it is left out.',
      'Workflow weekly-report has 2 schedules, and a note holds one: it is weekly-report-1, weekly-report-2 now. Its past runs keep the name weekly-report.',
    ]);
    expect(readFileSync(join(workspace, '.env'), 'utf8')).toBe(
      'PERO_TELEGRAM_BOT_TOKEN=123:abc\n',
    );
    expect(statSync(join(workspace, '.env')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(workspace, '.gitignore'), 'utf8')).toBe('.env\n');
    expect(readHostConfig(join(workspace, '.pero', 'config.yaml'))).toEqual({
      data: vault,
      settings: null,
      allowedChats: [
        { chatKey: '-100111', title: 'Home' },
        { chatKey: '42', title: null },
        { chatKey: '-100222', title: 'Work' },
      ],
    });
  });

  it('moves each split schedule its saved times, so no run is missed', async () => {
    await legacyDataDir();
    await migrate();
    const dataSource = await openDatabase(
      dataSourceOptions(join(workspace, '.pero', 'pero.sqlite')),
    );
    try {
      expect(
        await dataSource.query(
          `SELECT "workflow_name", "fingerprint", "next_run_at" FROM "schedules" ORDER BY "workflow_name"`,
        ),
      ).toEqual([
        {
          workflow_name: 'digest',
          fingerprint: scheduleFingerprint({
            cron: '*/15 9-17 * * 1-5',
            timezone: 'Europe/Berlin',
          }),
          next_run_at: '2026-09-30 07:15:00.000',
        },
        {
          workflow_name: 'weekly-report-1',
          fingerprint: scheduleFingerprint({
            cron: '0 12 * * 0',
            timezone: 'Europe/Berlin',
          }),
          next_run_at: '2026-10-04 10:00:00.000',
        },
        {
          workflow_name: 'weekly-report-2',
          fingerprint: scheduleFingerprint({
            cron: '30 18 * * 1-5',
            timezone: 'UTC',
          }),
          next_run_at: '2026-09-30 18:30:00.000',
        },
      ]);
      expect(
        await dataSource.query(
          `SELECT "w"."name", "t"."kind", "t"."enabled" FROM "triggers" "t" JOIN "workflows" "w" ON "w"."id" = "t"."workflow_id" ORDER BY "t"."id"`,
        ),
      ).toEqual([
        { name: 'weekly-report-1', kind: 'schedule', enabled: 1 },
        { name: 'weekly-report-2', kind: 'schedule', enabled: 1 },
        { name: 'weekly-report-1', kind: 'manual', enabled: 1 },
        { name: 'weekly-report-1', kind: 'schedule', enabled: 0 },
        { name: 'digest', kind: 'schedule', enabled: 1 },
        { name: 'paused', kind: 'schedule', enabled: 0 },
      ]);
      expect(await dataSource.query(`PRAGMA foreign_key_check`)).toEqual([]);
    } finally {
      await dataSource.destroy();
    }
  });

  it('stops before writing anything when a topic title leads to two Agents', async () => {
    await legacyDataDir({ extra: [channel('-100222:8', 'health', 1)] });
    const before = tree(source);

    await expect(migrate()).rejects.toThrow(
      'Nothing was written: each topic title must lead to one Agent. Rename one of each of these topics in Telegram (or fix it with pero agents and pero channels), then run pero migrate again:\n' +
        '  "Health" is the title of topics answered by different Agents: health-2 in Home/Health, Work/Health; main in Work/health',
    );
    expect(readdirSync(tmp).sort()).toEqual(['legacy', 'projects', 'vault']);
    expect(tree(source)).toEqual(before);
  });

  it('completes a migration that stopped part way, and replaces the skeleton of pero init', async () => {
    await legacyDataDir();
    await migrate();
    rmSync(join(workspace, '.pero', 'pero.sqlite'));
    rmSync(join(vault, 'Settings', 'Workflows', 'digest.md'));

    const again = await migrate();
    expect(again.check.problems).toEqual([]);
    expect(again.entries.filter((entry) => entry.action !== 'kept')).toEqual([
      {
        path: join(vault, 'Settings', 'Workflows', 'digest.md'),
        action: 'created',
      },
      { path: '.pero/pero.sqlite', action: 'created' },
    ]);
  });

  it('refuses a workspace with a database, and notes it would overwrite', async () => {
    await legacyDataDir();
    mkdirSync(join(workspace, '.pero'), { recursive: true });
    writeFileSync(join(workspace, '.pero', 'pero.sqlite'), '');
    await expect(migrate()).rejects.toThrow(
      `${workspace} already has a database, in ${join(workspace, '.pero')}. Migrate into a workspace without one.`,
    );

    rmSync(join(workspace, '.pero', 'pero.sqlite'));
    mkdirSync(join(vault, 'Settings'), { recursive: true });
    writeFileSync(join(vault, 'Settings', 'Pero.md'), 'Mine.\n');
    await expect(migrate()).rejects.toThrow(
      `Nothing was written: these notes already exist with other content. Move them aside, or migrate into another folder:\n  ${join(vault, 'Settings', 'Pero.md')}`,
    );
    expect(readdirSync(join(workspace, '.pero'))).toEqual([]);
  });

  it('refuses while a daemon holds the lock, and a workspace inside the data directory', async () => {
    await legacyDataDir();
    const lock = acquireDaemonLock(join(source, 'run', 'pero.lock'))!;
    try {
      await expect(migrate()).rejects.toThrow(
        `Pero is running for data directory ${source} — stop it with pero stop before migrating`,
      );
    } finally {
      lock.release();
    }
    await expect(
      migrateInstallation({
        source,
        workspace: join(source, 'workspace'),
        homeDir: tmp,
        hostTimeZone: 'UTC',
      }),
    ).rejects.toThrow('is inside the data directory');
  });
});
