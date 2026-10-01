import {
  type ChildProcess,
  execFile,
  execFileSync,
  spawn,
} from 'node:child_process';
import {
  existsSync,
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
import Database from 'better-sqlite3';
import type { Chat } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dataDirLayout,
  type DataDirLayout,
  MAX_SOCKET_PATH_BYTES,
  STATE_GITIGNORE,
} from '../src/config/data-dir.js';
import { PACKAGE_VERSION } from '../src/common/package-version.js';
import { initWorkspace } from '../src/config/workspace-skeleton.js';
import { createControlClient } from '../src/control/client.js';
import { FakeBotApi } from '../src/telegram/testing/fake-bot-api.js';
import {
  findRunningDaemon,
  readDaemonMetadata,
} from '../src/control/daemon-metadata.js';

// `npm run test:e2e` builds first.
const PERO = join(import.meta.dirname, '../bin/pero.js');
const DENY_DAEMON_DEPS = join(
  import.meta.dirname,
  'fixtures/deny-daemon-deps.mjs',
);

const NOT_RUNNING = "Pero isn't running — start it with pero run";

const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';
const OTHER_TOKEN = '987654321:BBEhBOweik6ad9r_QXMENQjcrGbqCr4K-xy';

/** `pero logs` shows this entry, in local time, for every started daemon. */
const STARTED_ENTRY =
  /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} INFO {2}Pero daemon started /m;

/**
 * For waits on a spawned `pero logs --follow`: starting the CLI alone can
 * take over the 1s `vi.waitFor` default on a busy macOS runner.
 */
const FOLLOWER_WAIT = { timeout: 10_000 };

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe('pero CLI (e2e)', { timeout: 60_000 }, () => {
  let tmp: string;
  let layout: DataDirLayout;
  /** Where backups of `layout` are restored. */
  let restored: DataDirLayout;
  /** Where the fake provider CLIs look for their sign-in. */
  let authDir: string;
  /** Other state directories a test started a daemon in. */
  const others: DataDirLayout[] = [];
  let api: FakeBotApi;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    api = new FakeBotApi();
    await api.listen();
    // Short: macOS limits socket paths to 104 bytes.
    tmp = mkdtempSync(join(tmpdir(), 'pero-'));
    layout = dataDirLayout(join(tmp, 'pero'));
    restored = dataDirLayout(join(tmp, 'restored'));
    authDir = join(tmp, 'auth');
    mkdirSync(authDir);
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
    for (const { metadataFile } of [layout, restored, ...others.splice(0)]) {
      const metadata = readDaemonMetadata(metadataFile);
      if (metadata) {
        kill(metadata.pid, 'SIGKILL');
        await vi.waitFor(() => expect(isAlive(metadata.pid)).toBe(false));
      }
    }
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Runs `pero` to completion with `input` on stdin, from `tmp` unless
   * `cwd` says otherwise; the environment carries no PERO_HOME,
   * PERO_WORKSPACE, or Telegram token, the fake provider CLIs that
   * the daemon inherits read their sign-in from `authDir`, and Telegram is
   * the fake Bot API.
   */
  function pero(
    args: string[],
    options: {
      env?: NodeJS.ProcessEnv;
      nodeArgs?: string[];
      cwd?: string;
      input?: string;
    } = {},
  ): Promise<Result> {
    const {
      PERO_HOME: _home,
      PERO_WORKSPACE: _workspace,
      PERO_TELEGRAM_BOT_TOKEN: _token,
      ...env
    } = process.env;
    return new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [...(options.nodeArgs ?? []), PERO, ...args],
        {
          env: {
            ...env,
            PERO_FAKE_AUTH_DIR: authDir,
            // The daemon inherits it, so Telegram is always the fake.
            PERO_TELEGRAM_API_ROOT: api.url,
            ...options.env,
          },
          cwd: options.cwd ?? tmp,
        },
        (error, stdout, stderr) => {
          const code = error ? (error.code as number | null) : 0;
          resolve({ code, stdout, stderr });
        },
      );
      child.stdin!.end(options.input ?? '');
    });
  }

  /**
   * `pero status` once it shows the bot connected to the fake Bot API;
   * degraded while no chat is allowed.
   */
  async function connectedStatus(
    target: (...args: string[]) => string[] = withDataDir,
  ): Promise<Result> {
    let status: Result | undefined;
    await vi.waitFor(
      async () => {
        status = await pero(target('status'));
        expect(status.stdout).toMatch(
          /telegram +(ok|degraded) +Connected as @pero_test_bot(\n|; no chat is allowed yet)/,
        );
      },
      { timeout: 10_000, interval: 200 },
    );
    return status!;
  }

  const withDataDir = (...args: string[]) => [
    '--data-dir',
    layout.root,
    ...args,
  ];

  /**
   * Makes `tmp/ws` a workspace, with `notes` by their path in its settings
   * folder, and the installation the test runs; returns the arguments
   * that run `pero` there.
   */
  function useWorkspace(
    notes: Record<string, string> = {},
  ): (...args: string[]) => string[] {
    const root = join(realpathSync(tmp), 'ws');
    initWorkspace(root, tmp);
    for (const [file, text] of Object.entries(notes)) {
      writeFileSync(join(root, 'data', 'Settings', file), text);
    }
    layout = dataDirLayout(join(root, '.pero'), root);
    return (...args) => ['-w', root, ...args];
  }

  /** Restarts the daemon of `target`, which then reads its notes again. */
  async function restart(target: (...args: string[]) => string[]) {
    expect((await pero(target('stop'))).code).toBe(0);
    expect((await pero(target('run'))).code).toBe(0);
  }

  it('runs once, reports status, and stops safely twice', async () => {
    const first = await pero(withDataDir('run'));
    expect(first).toMatchObject({ code: 0, stderr: '' });
    const pid = Number(/\(pid (\d+),/.exec(first.stdout)?.[1]);
    expect(first.stdout).toContain(
      `Pero is running (pid ${pid}, data directory ${layout.root})`,
    );
    expect(first.stdout).toContain(
      [
        'Setup needed:',
        '  This legacy data directory has no Agents — pero init <folder> makes a workspace, whose notes define them',
        '  Telegram: Bot token is not set — pero settings set telegram-bot-token (reads it from stdin), or start Pero with PERO_TELEGRAM_BOT_TOKEN',
        '  claude: Not signed in — run claude auth login, then pero run to check again',
        'Run pero run in a terminal to set these up step by step.',
      ].join('\n'),
    );
    // Codex is neither the default provider nor used by an Agent.
    expect(first.stdout).not.toContain('codex');

    const second = await pero(withDataDir('run'));
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`Pero is already running (pid ${pid},`);
    expect(readDaemonMetadata(layout.metadataFile)?.pid).toBe(pid);

    const status = await pero(withDataDir('status'));
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(new RegExp(`PID +${pid}\\n`));
    expect(status.stdout).toMatch(/Health +degraded/);
    for (const name of ['claude', 'codex', 'telegram']) {
      expect(status.stdout).toMatch(new RegExp(`${name} +unconfigured`));
    }
    expect(status.stdout).toMatch(/codex +unconfigured .*\(not in use\)\n/);

    const stop = await pero(withDataDir('stop'));
    expect(stop).toMatchObject({ code: 0, stdout: 'Pero stopped\n' });
    expect(isAlive(pid)).toBe(false);
    expect(readdirSync(layout.run)).toEqual(['pero.lock']);

    const again = await pero(withDataDir('stop'));
    expect(again).toMatchObject({
      code: 0,
      stdout: `Pero isn't running (data directory ${layout.root})\n`,
    });
  });

  it('configures Telegram through settings without a restart, never showing the token', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const pid = readDaemonMetadata(layout.metadataFile)?.pid;
    const before = await pero(withDataDir('status'));
    expect(before.stdout).toMatch(
      /telegram +unconfigured +Bot token is not set/,
    );
    expect(before.stdout).toMatch(/Health +degraded/);

    const set = await pero(
      withDataDir('settings', 'set', 'telegram-bot-token'),
      {
        input: `${TOKEN}\n`,
      },
    );
    expect(set).toMatchObject({
      code: 0,
      stdout: 'telegram-bot-token is now set (secrets)\n',
      stderr: '',
    });

    // Connecting happens in the background, without a restart.
    const status = await connectedStatus();
    expect(status.stdout).toMatch(new RegExp(`PID +${pid}\\n`));
    expect(api.callsOf('getMe')[0]?.token).toBe(TOKEN);
    const show = await pero(withDataDir('settings', 'show'));
    expect(show.code).toBe(0);
    expect(show.stdout).toMatch(/^Telegram bot token: set \(secrets\)$/m);
    const secret = join(layout.secrets, 'telegram-bot-token');
    expect(statSync(secret).mode & 0o777).toBe(0o600);
    expect(readFileSync(secret, 'utf8')).toBe(`${TOKEN}\n`);

    expect((await pero(withDataDir('stop'))).code).toBe(0);
    const seen = [
      set.stdout,
      set.stderr,
      status.stdout,
      status.stderr,
      show.stdout,
      show.stderr,
      readFileSync(layout.logFile, 'utf8'),
      readFileSync(layout.daemonOutputFile, 'utf8'),
    ];
    for (const text of seen) expect(text).not.toContain(TOKEN.split(':')[1]);
  });

  it('keeps the token of a workspace in its .env, which Git must ignore', async () => {
    const workspace = join(realpathSync(tmp), 'ws');
    const state = dataDirLayout(join(workspace, '.pero'), workspace);
    others.push(state);
    const ws = (...args: string[]) => ['-w', workspace, ...args];
    mkdirSync(workspace);
    execFileSync('git', ['init', '-q', workspace]);
    writeFileSync(join(workspace, '.gitignore'), 'node_modules/\n');

    expect((await pero(ws('run'))).code).toBe(0);
    const set = await pero(ws('settings', 'set', 'telegram-bot-token'), {
      input: `${TOKEN}\n`,
    });
    expect(set).toMatchObject({
      code: 0,
      stdout: 'telegram-bot-token is now set (.env)\n',
    });
    const envFile = join(workspace, '.env');
    expect(readFileSync(envFile, 'utf8')).toBe(
      `PERO_TELEGRAM_BOT_TOKEN=${TOKEN}\n`,
    );
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(existsSync(join(state.root, 'secrets'))).toBe(false);

    // Stored again, the .gitignore line is not added twice.
    await pero(ws('settings', 'set', 'telegram-bot-token'), {
      input: `${OTHER_TOKEN}\n`,
    });
    expect(readFileSync(join(workspace, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n.env\n',
    );
    let status: Result | undefined;
    await vi.waitFor(
      async () => {
        status = await pero(ws('status'));
        expect(status.stdout).toMatch(/telegram +(ok|degraded) +Connected/);
      },
      { timeout: 10_000, interval: 200 },
    );
    expect(status!.stdout).not.toContain('Error:');
    const show = await pero(ws('settings', 'show'));
    expect(show.stdout).toMatch(/^Telegram bot token: set \(\.env\)$/m);

    // A tracked .env is an error, whether or not Pero runs.
    execFileSync('git', ['-C', workspace, 'add', '-f', '.env']);
    const tracked = await pero(ws('status'));
    expect(tracked.code).toBe(0);
    expect(tracked.stdout).toContain('\nError: .env is tracked by Git');
    expect((await pero(ws('stop'))).code).toBe(0);
    const stopped = await pero(ws('status'));
    expect(stopped.code).toBe(3);
    expect(stopped.stderr).toContain('Error: .env is tracked by Git');

    const seen = [
      set.stdout,
      set.stderr,
      status!.stdout,
      show.stdout,
      readFileSync(state.logFile, 'utf8'),
      readFileSync(state.daemonOutputFile, 'utf8'),
    ];
    for (const text of seen) {
      expect(text).not.toContain(TOKEN.split(':')[1]);
      expect(text).not.toContain(OTHER_TOKEN.split(':')[1]);
    }
  });

  it('allows, lists, and denies Telegram chats', async () => {
    api.chats.set('-1001234567890', {
      id: -1001234567890,
      type: 'supergroup',
      title: 'Household',
      is_forum: true,
    });
    expect((await pero(withDataDir('run'))).code).toBe(0);
    await pero(withDataDir('settings', 'set', 'telegram-bot-token'), {
      input: `${TOKEN}\n`,
    });
    const before = await connectedStatus();
    expect(before.stdout).toMatch(
      /telegram +degraded +Connected as @pero_test_bot; no chat is allowed yet: add the bot to a group or message it, then pero telegram allow <chat-id>\n/,
    );
    const run = await pero(withDataDir('run'));
    expect(run.stdout).toContain(
      '  Telegram: no chat is allowed yet — add the bot to a group as an administrator or message it, then pero telegram allow <chat-id>',
    );
    expect((await pero(withDataDir('telegram'))).stdout).toContain(
      'No chat is allowed yet. To pair one:',
    );

    // A group's ID is negative, which must not pass for an option.
    writeFileSync(
      layout.configFile,
      `${readFileSync(layout.configFile, 'utf8')}# my own note\n`,
    );
    const allow = await pero(
      withDataDir('telegram', 'allow', '-1001234567890'),
    );
    expect(allow).toMatchObject({ code: 0, stderr: '' });
    expect(allow.stdout).toBe('Allowed: group "Household" (-1001234567890)\n');
    expect(readFileSync(layout.configFile, 'utf8')).toContain(
      '  allowed-chats:\n    - id: -1001234567890\n      title: Household\n',
    );
    const again = await pero([
      'telegram',
      'allow',
      '-1001234567890',
      '--data-dir',
      layout.root,
    ]);
    expect(again.stdout).toBe(
      'Already allowed: group "Household" (-1001234567890)\n',
    );
    const chats = await pero(withDataDir('telegram', 'chats'));
    expect(chats).toMatchObject({ code: 0, stderr: '' });
    expect(chats.stdout).toMatch(/^Bot: @pero_test_bot$/m);
    expect(chats.stdout).toMatch(
      /^ {2}-1001234567890 +group +Household +on +administrator$/m,
    );
    const status = await pero(withDataDir('status'));
    expect(status.stdout).toMatch(
      /telegram +ok +Connected as @pero_test_bot\n/,
    );

    const deny = await pero(withDataDir('telegram', 'deny', '-1001234567890'));
    expect(deny).toMatchObject({
      code: 0,
      stdout:
        'Denied: group "Household" (-1001234567890). Its Channels and Agents are kept and resume if you allow it again.\n',
    });
    const config = readFileSync(layout.configFile, 'utf8');
    // The template's own comments show an example entry with the same ID.
    expect(config).not.toContain('\n    - id: -1001234567890\n');
    expect(config).toMatch(/# my own note\n$/);
    const missing = await pero(
      withDataDir('telegram', 'deny', '-1001234567890'),
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(
      'Telegram chat -1001234567890 is not allowed',
    );
    const invalid = await pero(withDataDir('telegram', 'allow', 'general'));
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain(
      'chat-id: must be a Telegram chat ID, such as -1001234567890 or 123456789',
    );
  });

  it('refuses a token as an argument, and one that is not valid, without echoing either', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);

    const argument = await pero(
      withDataDir('settings', 'set', 'telegram-bot-token', TOKEN),
    );
    expect(argument).toMatchObject({
      code: 1,
      stdout: '',
      stderr:
        'Pass telegram-bot-token on stdin or at the prompt, not as an argument, so it stays out of shell history\n',
    });

    const invalid = await pero(
      withDataDir('settings', 'set', 'telegram-bot-token'),
      { input: 'secret-but-wrong\n' },
    );
    expect(invalid).toMatchObject({
      code: 1,
      stdout: '',
      stderr:
        'telegram-bot-token: must be a bot token from @BotFather, such as 123456789:AAE…\n',
    });
    expect(existsSync(join(layout.secrets, 'telegram-bot-token'))).toBe(false);
    expect((await pero(withDataDir('stop'))).code).toBe(0);
    expect(readFileSync(layout.logFile, 'utf8')).not.toContain(
      'secret-but-wrong',
    );
  });

  it('names the file to edit instead of changing Agents and settings', async () => {
    const workspace = join(realpathSync(tmp), 'ws');
    expect((await pero(['init', workspace])).code).toBe(0);
    mkdirSync(join(workspace, 'data', 'Settings', 'Agents', 'Home'));
    writeFileSync(
      join(workspace, 'data', 'Settings', 'Agents', 'Home', 'Health Coach.md'),
      'You coach.\n',
    );
    // Whether or not Pero runs, and with any of the old options.
    const ws = (...args: string[]) => pero(['-w', workspace, ...args]);
    const agents = 'Agents are configured in notes now';
    expect(await ws('agents', 'create', 'Garden', '--model', 'opus')).toEqual({
      code: 1,
      stdout: '',
      stderr: `${agents}: add data/Settings/Agents/Garden.md (Agents/_Template.md shows the properties).\n`,
    });
    expect(await ws('agents', 'create', 'health-coach')).toMatchObject({
      code: 1,
      stderr: `${agents}, and data/Settings/Agents/Home/Health Coach.md already defines health-coach; edit it there.\n`,
    });
    expect(
      await ws('agents', 'edit', 'Health Coach', '--instructions', '-'),
    ).toMatchObject({
      code: 1,
      stderr: `${agents}: edit data/Settings/Agents/Home/Health Coach.md.\n`,
    });
    expect(await ws('agents', 'disable', 'health-coach')).toMatchObject({
      code: 1,
      stderr: `${agents}: set enabled: false in data/Settings/Agents/Home/Health Coach.md.\n`,
    });
    expect(await ws('agents', 'enable', 'nobody')).toMatchObject({
      code: 1,
      stderr: `${agents}, and no note is named nobody: add data/Settings/Agents/nobody.md (Agents/_Template.md shows the properties).\n`,
    });
    expect(await ws('settings', 'set', 'claude.model', 'opus')).toMatchObject({
      code: 1,
      stderr:
        'Settings are in notes now: set claude-model in data/Settings/Pero.md.\n',
    });
    expect(await ws('settings', 'unset', 'default-permissions')).toMatchObject({
      code: 1,
      stderr:
        'Settings are in notes now: set permissions in data/Settings/Pero.md.\n',
    });
    expect(await ws('settings', 'set', 'shared-instructions')).toMatchObject({
      code: 1,
      stderr:
        "Settings are in notes now: edit the body of data/Settings/Pero.md, which goes before each Agent's own instructions.\n",
    });
    expect(
      await ws('settings', 'set', 'default-working-directory', 'vault'),
    ).toMatchObject({
      code: 1,
      stderr:
        'The data folder is set in config.yaml now: set data in .pero/config.yaml, then restart Pero.\n',
    });
    expect(await ws('settings', 'set', 'nope', 'x')).toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/^Unknown setting "nope"\. Settings: /),
    });

    // A legacy data directory, running or not, has nothing to change.
    const legacy = `${layout.root} is a legacy data directory, which has no Agents any more. Make a workspace with pero init <folder>, whose notes define them.\n`;
    expect(await pero(withDataDir('agents', 'create', 'notes'))).toEqual({
      code: 1,
      stdout: '',
      stderr: legacy,
    });
    expect((await pero(withDataDir('run'))).code).toBe(0);
    expect(
      await pero(withDataDir('settings', 'set', 'timezone', 'UTC')),
    ).toMatchObject({ code: 1, stderr: legacy });
    expect((await pero(withDataDir('settings'))).stdout).toBe(
      `${legacy}Telegram bot token: not set\n`,
    );
    expect((await pero(withDataDir('status'))).stdout).toContain(
      'settings  degraded      legacy data directory: no Agents answer; make a workspace with pero init <folder>',
    );
  });

  it('shows the Agents and settings the notes hold, as they change', async () => {
    const workspace = join(realpathSync(tmp), 'ws');
    const settingsFolder = join(workspace, 'data', 'Settings');
    const state = dataDirLayout(join(workspace, '.pero'), workspace);
    others.push(state);
    expect((await pero(['init', workspace])).code).toBe(0);
    writeFileSync(
      join(settingsFolder, 'Pero.md'),
      '---\nclaude-effort: high\ntimezone: Europe/Berlin\n---\nBe brief.\n',
    );
    mkdirSync(join(settingsFolder, 'Agents', 'Home'));
    writeFileSync(
      join(settingsFolder, 'Agents', 'Home', 'Coach.md'),
      '---\ntopics: [Health, Running]\nmodel: sonnet\npermissions: bypass\nworking-directory: data/Health\n---\nYou coach.\n',
    );
    mkdirSync(join(workspace, 'data', 'Health'));
    writeFileSync(
      join(settingsFolder, 'Agents', 'Broken.md'),
      '---\nmodle: opus\n---\n',
    );
    const ws = (...args: string[]) => pero(['-w', workspace, ...args]);
    expect((await ws('run')).code).toBe(0);

    const ls = await ws('agents');
    expect(ls).toMatchObject({ code: 0, stderr: '' });
    expect(ls.stdout).toMatch(
      new RegExp(
        `^coach +claude +sonnet +high +${escape(join(workspace, 'data', 'Health'))} +bypass +enabled +Health, Running +data/Settings/Agents/Home/Coach\\.md$`,
        'm',
      ),
    );
    expect(ls.stdout).toMatch(
      new RegExp(
        `^main \\* +claude +default +high +${escape(join(workspace, 'data'))} \\(data folder\\) +ask +enabled +— +data/Settings/Agents/Main\\.md$`,
        'm',
      ),
    );
    const show = await ws('agents', 'show', 'Coach');
    expect(show).toMatchObject({ code: 0, stderr: '' });
    expect(show.stdout).toBe(
      [
        'Agent coach "Coach"',
        '  note                 data/Settings/Agents/Home/Coach.md',
        '  topics               Health, Running',
        '  provider             claude (default)',
        '  model                sonnet',
        '  effort               high (Pero.md)',
        `  working directory    ${join(workspace, 'data', 'Health')}`,
        '  instructions         You coach.',
        '  shared instructions  on',
        '  permissions          bypass',
        '  codex git check      required',
        '  state                enabled',
        '  main agent           no',
        '',
        'No Channel goes to it yet.',
        '',
      ].join('\n'),
    );
    expect(await ws('channels', 'assign', '3', 'coach')).toEqual({
      code: 1,
      stdout: '',
      stderr:
        "Topics are routed by the Agent notes' topics now: add the topic's " +
        'title to topics in data/Settings/Agents/Home/Coach.md; pero ' +
        "channels ls shows each topic's title and who answers there.\n",
    });
    expect(await ws('agents', 'show', 'broken')).toMatchObject({
      code: 1,
      stderr:
        "Agent broken isn't loaded: data/Settings/Agents/Broken.md has errors; pero check lists them\n",
    });
    expect(await ws('agents', 'show', 'nobody')).toMatchObject({
      code: 1,
      stderr: 'No Agent named nobody\n',
    });

    const settings = await ws('settings');
    expect(settings).toMatchObject({ code: 0, stderr: '' });
    expect(settings.stdout).toContain(
      [
        'data/Settings/Pero.md',
        '  provider                claude (default)',
        '  claude-model            (provider default)',
        '  claude-effort           high',
      ].join('\n'),
    );
    expect(settings.stdout).toMatch(/^ {2}timezone +Europe\/Berlin$/m);
    expect(settings.stdout).toMatch(/^ {2}\(body\) +Be brief\.$/m);
    expect(settings.stdout).toContain(
      `.pero/config.yaml\n  data                    ${join(workspace, 'data')}\n`,
    );

    // An edit to Pero.md applies within a rescan.
    writeFileSync(
      join(settingsFolder, 'Pero.md'),
      '---\nclaude-model: opus\nclaude-effort: high\n---\nBe brief.\n',
    );
    await vi.waitFor(
      async () =>
        expect((await ws('agents', 'show', 'main')).stdout).toContain(
          '  model                opus (Pero.md)\n',
        ),
      { timeout: 15_000, interval: 500 },
    );
    expect((await ws('stop')).code).toBe(0);
  }, 30_000);

  it('lists, shows, assigns, disables, and enables Channels, and prints their history', async () => {
    const ws = useWorkspace({ 'Agents/Chef.md': 'You cook.\n' });
    const channels = (...args: string[]) => pero(ws('channels', ...args));
    expect(await channels()).toMatchObject({
      code: 1,
      stderr: `${NOT_RUNNING}\n`,
    });

    const forum: Chat.SupergroupChat = {
      id: -1001234567890,
      type: 'supergroup',
      title: 'Household',
      is_forum: true,
    };
    api.chats.set(String(forum.id), forum);
    expect((await pero(ws('run'))).code).toBe(0);
    await pero(ws('settings', 'set', 'telegram-bot-token'), {
      input: `${TOKEN}\n`,
    });
    await connectedStatus(ws);
    expect(await channels()).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(/^No Channels yet\. /),
    });
    await pero(ws('telegram', 'allow', String(forum.id)));
    api.push({
      message: {
        message_id: 1,
        date: 0,
        chat: forum,
        from: { id: 1234, is_bot: false, first_name: 'Ada' },
        message_thread_id: 42,
        is_topic_message: true,
        forum_topic_created: { name: 'Groceries', icon_color: 0 },
      },
    } as never);
    await vi.waitFor(() => expect(api.sent()).toHaveLength(1));

    expect(await channels()).toEqual({
      code: 0,
      stdout:
        'ID  CHANNEL                     TITLE      AGENT\n' +
        '1   telegram -1001234567890:42  Groceries  groceries\n',
      stderr: '',
    });
    const show = await channels('show', '1');
    expect(show.code).toBe(0);
    expect(show.stdout).toMatch(/^Channel 1 "Groceries"\n/);
    expect(show.stdout).toMatch(/^ {2}next turn +starts its first Session$/m);
    expect(show.stdout).toMatch(/^ {2}history +1 message, the latest at /m);

    // Notes route topics now.
    for (const args of [
      ['assign', '1', 'chef'],
      ['disable', '1'],
      ['enable', '1'],
    ]) {
      expect(await channels(...args)).toMatchObject({
        code: 1,
        stdout: '',
        stderr: expect.stringContaining(
          "Topics are routed by the Agent notes' topics now",
        ),
      });
    }

    const history = await channels('history', '1', '-n', '5');
    expect(history.code).toBe(0);
    expect(history.stdout).toMatch(
      /^\d{4}-\d\d-\d\d \d\d:\d\d {2}out {2}pero {2}This topic talks to Agent groceries: /,
    );

    expect(await channels('history', '1', '-n', '0')).toMatchObject({
      code: 1,
      stderr: '--lines must be a whole number from 1 to 500, not "0"\n',
    });
    expect(await channels('show', 'groceries')).toMatchObject({
      code: 1,
      stderr:
        'channel must be a Channel ID, as pero channels ls lists it, not "groceries"\n',
    });
    expect(await channels('show', '9')).toMatchObject({
      code: 1,
      stderr: 'No Channel with ID 9\n',
    });

    // A Workflow note posts its runs to the topic, by its title.
    writeFileSync(
      join(tmp, 'ws', 'data', 'Settings', 'Workflows', 'Brief.md'),
      '---\nagent: chef\nchannel: Groceries\n---\nGo\n',
    );
    await restart(ws);
    const workflows = (...args: string[]) => pero(ws('workflows', ...args));
    expect((await workflows('show', 'brief')).stdout).toContain(
      [
        'Posts to',
        '  ID  CHANNEL                     TITLE',
        '  1   telegram -1001234567890:42  Groceries',
      ].join('\n'),
    );
    expect(await workflows('notify', 'brief', '1')).toEqual({
      code: 1,
      stdout: '',
      stderr:
        "Workflows are configured in notes now: add the topic's title to channel in data/Settings/Workflows/Brief.md; pero channels ls shows each topic's title.\n",
    });
    expect(
      (await workflows('notify', 'brief', '1', '--remove')).stderr,
    ).toContain("take the topic's title out of channel in");
  });

  it('lists and shows the Workflows notes define, and names the note instead of each removed command', async () => {
    const ws = useWorkspace({
      'Pero.md': '---\ntimezone: Europe/Berlin\n---\n',
      'Agents/Coach.md': 'You coach.\n',
    });
    const workflows = (...args: string[]) => pero(ws('workflows', ...args));
    const triggers = (...args: string[]) => pero(ws('triggers', ...args));
    const prefix = 'Workflows are configured in notes now';

    // The stubs answer with Pero stopped too, whatever options they get.
    expect(
      await workflows(
        'create',
        'evening-review',
        '--agent',
        'coach',
        '--input',
        'Go',
      ),
    ).toEqual({
      code: 1,
      stdout: '',
      stderr: `${prefix}: add data/Settings/Workflows/evening-review.md: its text is what each run asks the Agent, and hour and channel say when it runs and where it posts.\n`,
    });
    expect((await pero(ws('run'))).code).toBe(0);
    expect(await workflows()).toMatchObject({
      code: 0,
      stdout:
        'No Workflows yet. Add a note to the Workflows folder in the settings folder.\n',
    });

    writeFileSync(
      join(tmp, 'ws', 'data', 'Settings', 'Workflows', 'Evening review.md'),
      "---\nhour: 21\nagent: coach\n---\nReview today's chats.\n",
    );
    await restart(ws);
    const listed = await workflows();
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(
      new RegExp(
        [
          'NAME +AGENT +SCHEDULE +NEXT RUN +CHANNELS +STATE +NOTE',
          'evening-review +coach +0 21 \\* \\* \\* \\(Europe/Berlin\\) +\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d +— +enabled +data/Settings/Workflows/Evening review\\.md',
          '',
        ].join('\n'),
      ),
    );
    const shown = await workflows('show', 'Evening-Review');
    expect(shown.code).toBe(0);
    expect(shown.stdout).toMatch(
      new RegExp(
        [
          '^Workflow evening-review "Evening review"',
          '  note      data/Settings/Workflows/Evening review\\.md',
          '  agent     coach',
          "  input     Review today's chats\\.",
          '  schedule  0 21 \\* \\* \\* \\(Europe/Berlin\\)',
          '  next run  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d',
          '  last run  never',
        ].join('\n'),
      ),
    );
    expect(shown.stdout).toMatch(
      /\n\nPosts to no Channel: name a topic in channel in its note to post its answers there\.\n$/,
    );
    expect(await workflows('show', 'nothing')).toMatchObject({
      code: 1,
      stderr: 'No Workflow named nothing\n',
    });

    const note = 'data/Settings/Workflows/Evening review.md';
    for (const [args, message] of [
      [['edit', 'evening-review', '--title', 'x'], `edit ${note}.`],
      [['enable', 'evening-review'], `set enabled: true in ${note}.`],
      [
        ['disable', 'evening-review'],
        `set enabled: false in ${note}, which stops its schedule; pero workflows run still runs it.`,
      ],
    ] as const) {
      expect(await workflows(...args)).toEqual({
        code: 1,
        stdout: '',
        stderr: `${prefix}: ${message}\n`,
      });
    }
    expect(
      await workflows('create', 'evening-review', '--input', 'Go'),
    ).toMatchObject({
      code: 1,
      stderr: `${prefix}, and ${note} already defines evening-review; edit it there.\n`,
    });

    const schedules = 'Workflows run on the schedules their notes set now';
    expect(await triggers()).toEqual({
      code: 1,
      stdout: '',
      stderr: `${schedules}: pero workflows ls shows each schedule and its next run.\n`,
    });
    expect(
      await triggers('add', 'evening-review', '--cron', '0 9 * * *'),
    ).toMatchObject({
      code: 1,
      stderr: `${schedules}: set hour, day, and minute, or cron, in ${note}; any Workflow runs by hand with pero workflows run <name>.\n`,
    });
    for (const action of ['remove', 'disable', 'enable']) {
      expect(await triggers(action, '1')).toMatchObject({
        code: 1,
        stderr: expect.stringContaining(`${schedules}: set trigger: `),
      });
    }

    writeFileSync(
      join(tmp, 'ws', 'data', 'Settings', 'Agents', 'Coach.md'),
      '---\nenabled: false\n---\nYou coach.\n',
    );
    await restart(ws);
    expect((await workflows('show', 'evening-review')).stdout).toContain(
      '\nWarning: Agent coach is disabled or has no note, so this Workflow cannot run until it is enabled again (enabled: true in its note).\n',
    );
  });

  it("runs a Workflow by hand and prints the Agent's answer", async () => {
    const ws = useWorkspace({
      'Agents/Coach.md': 'You coach.\n',
      'Workflows/Brief.md':
        '---\nagent: coach\nhour: 9\nmax-attempts: 3\n---\nSummarize the day.\n',
    });
    const run = await pero(ws('run'), {
      env: { PERO_FAKE_RUNTIME: 'echo' },
    });
    expect(run.code).toBe(0);
    const workflows = (...args: string[]) => pero(ws('workflows', ...args));

    expect(await workflows('run', 'nothing')).toMatchObject({
      code: 1,
      stdout: '',
      stderr: 'No Workflow named nothing\n',
    });
    expect(await workflows('run', 'brief')).toEqual({
      code: 0,
      stdout: 'echo: Summarize the day.\n',
      stderr: 'Queued run 1 of Workflow brief…\n',
    });
    expect(await workflows('run', 'brief', '--no-wait')).toEqual({
      code: 0,
      stdout: 'Queued run 2 of Workflow brief; it runs in the background.\n',
      stderr: '',
    });

    const runs = (...args: string[]) => pero(ws('runs', ...args));
    expect(await runs('cancel', '1')).toMatchObject({
      code: 1,
      stderr: 'Run 1 has already finished (completed)\n',
    });
    expect(await runs('cancel', 'brief')).toMatchObject({
      code: 1,
      stderr: 'run must be a run ID, not "brief"\n',
    });
    expect(await runs('cancel', '9')).toMatchObject({
      code: 1,
      stderr: 'No run with ID 9\n',
    });

    expect((await workflows('show', 'brief')).stdout).toContain(
      '  attempts  up to 3 (a run Pero stops starts again when Pero does)\n',
    );
  });

  it('lists, shows, and retries runs and Notifications', async () => {
    const echo = { env: { PERO_FAKE_RUNTIME: 'echo' } };
    const ws = useWorkspace({
      'Agents/Coach.md': 'You coach.\n',
      'Workflows/Brief.md': '---\nagent: coach\n---\nSummarize the day.\n',
    });
    expect((await pero(ws('run'), echo)).code).toBe(0);
    const runs = (...args: string[]) => pero(ws('runs', ...args));
    const notifications = (...args: string[]) =>
      pero(ws('notifications', ...args));

    expect(await runs()).toEqual({
      code: 0,
      stdout: 'No runs yet. pero workflows run <name> starts one by hand.\n',
      stderr: '',
    });
    expect((await pero(ws('workflows', 'run', 'brief'))).code).toBe(0);
    expect(await runs('retry', '1')).toMatchObject({
      code: 1,
      stderr: 'Run 1 completed; pero workflows run brief starts another\n',
    });

    // Run 1 failed, and left a Notification that could not be delivered.
    expect((await pero(ws('stop'))).code).toBe(0);
    const db = new Database(layout.database);
    db.prepare(
      `UPDATE "workflow_runs" SET "status" = 'failed', "result_json" = NULL, ` +
        `"error_text" = 'The model is overloaded' WHERE "id" = 1`,
    ).run();
    db.prepare(
      `INSERT INTO "channels" ("integration_kind", "external_key", "address_json", "title") ` +
        `VALUES ('telegram', '-100:7', '{"chatId":"-100","topicId":7}', 'English')`,
    ).run();
    db.prepare(
      `INSERT INTO "notifications" ("workflow_run_id", "channel_id", "status", "payload", "attempt", "last_error") ` +
        `VALUES (1, 1, 'failed', '{"text":"Run 1 of Workflow brief failed"}', 10, 'Telegram is unreachable')`,
    ).run();
    db.close();
    expect((await pero(ws('run'), echo)).code).toBe(0);

    const listed = await runs('ls', '--status', 'failed');
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(
      /^ID +WORKFLOW +STATUS +ATTEMPT +STARTED BY +CREATED +FINISHED\n1 +brief +failed +1 +manual +/,
    );
    const shown = await runs('show', '1');
    expect(shown.stdout).toContain('Run 1 of Workflow brief\n');
    expect(shown.stdout).toContain('\nError\n  The model is overloaded\n');
    expect(shown.stdout).toMatch(
      /\nNotifications\n  ID +CHANNEL +STATUS +ATTEMPTS +NEXT ATTEMPT +LAST ERROR\n  1 +1 English +failed +10\/10 +— +Telegram is unreachable\n/,
    );
    expect(shown.stdout).toMatch(/pero runs retry 1 queues it again\.\n$/);

    expect(await runs('retry', '1')).toEqual({
      code: 0,
      stdout: 'echo: Summarize the day.\n',
      stderr: 'Queued run 2 to retry run 1 of Workflow brief…\n',
    });
    expect((await runs('show', '1')).stdout).toContain('  retried by  run 2\n');
    expect((await runs('show', '2')).stdout).toContain(
      '  started by  retry of run 1\n',
    );
    expect(await runs('retry', '1')).toMatchObject({
      code: 1,
      stderr: 'Run 1 is already retried by run 2; retry that one instead\n',
    });
    expect(await runs('ls', '--status', 'lost')).toMatchObject({
      code: 1,
      stderr:
        '--status must be one of pending, running, completed, failed, cancelled, interrupted, not "lost"\n',
    });
    expect(await runs('ls', '-n', '0')).toMatchObject({
      code: 1,
      stderr: '--lines must be a whole number from 1 to 500, not "0"\n',
    });
    expect((await runs('ls', '-n', '1')).stdout).toMatch(
      /\n2 +brief +completed +2 +retry of run 1 /,
    );

    const notificationList = await notifications();
    expect(notificationList.stdout).toMatch(
      /^ID +RUN +WORKFLOW +CHANNEL +STATUS +ATTEMPTS +NEXT ATTEMPT +LAST ERROR\n1 +1 +brief +1 English +failed +10\/10 +— +Telegram is unreachable\n$/,
    );
    expect((await notifications('ls', '--status', 'delivered')).stdout).toBe(
      'No Notifications match.\n',
    );
    const notification = await notifications('show', '1');
    expect(notification.stdout).toContain(
      '  to            Channel 1 (telegram -100:7 "English")\n',
    );
    expect(notification.stdout).toContain(
      '\nMessage\n  Run 1 of Workflow brief failed\n',
    );
    // The chat was never allowed, and there is no bot token.
    expect(notification.stdout).toMatch(
      /\n\nIts Channel's chat is no longer allowed; pero telegram chats lists the chats, and pero telegram allow <chat-id> allows it again\.\nTelegram: Bot token is not set; pero status shows more\.\npero notifications retry 1 tries it again with fresh attempts\.\n$/,
    );

    const retried = await notifications('retry', '1');
    expect(retried.code).toBe(1);
    expect(retried.stderr).toMatch(
      /^Delivering Notification 1…\nCould not deliver Notification 1: the chat is no longer allowed\nIts Channel's chat is no longer allowed; pero telegram chats lists the chats, and pero telegram allow <chat-id> allows it again\.\nTelegram: Bot token is not set; pero status shows more\.\n$/,
    );
    expect((await notifications('show', '1')).stdout).toContain(
      '  attempts      1/10\n',
    );
    expect(await notifications('retry', '1', '--no-wait')).toEqual({
      code: 0,
      stdout: 'Notification 1 is due now; Pero delivers it within seconds.\n',
      stderr: '',
    });
    expect(await notifications('show', '9')).toMatchObject({
      code: 1,
      stderr: 'No Notification with ID 9\n',
    });
  });

  it('shows the Channel history a Workflow reads, and skips a run with none', async () => {
    const english = (properties: string) =>
      writeFileSync(
        join(tmp, 'ws', 'data', 'Settings', 'Workflows', 'English.md'),
        `---\nagent: coach\n${properties}---\nSuggest improvements: {{history}}\n`,
      );
    const ws = useWorkspace({ 'Agents/Coach.md': 'You coach.\n' });
    const echo = { env: { PERO_FAKE_RUNTIME: 'echo' } };
    english('history: true\nhistory-channels: 7\n');
    expect((await pero(ws('run'), echo)).code).toBe(0);
    const workflows = (...args: string[]) => pero(ws('workflows', ...args));

    expect(await workflows('show', 'english')).toMatchObject({
      code: 1,
      stderr:
        "Workflow english isn't loaded: data/Settings/Workflows/English.md has errors; pero check lists them\n",
    });
    expect((await pero(ws('check'))).stdout).toContain(
      'history-channels: no Channel has the ID 7',
    );

    english('history: true\n');
    await restart(ws);
    expect((await workflows('show', 'english')).stdout).toContain(
      "  history   people's messages in all Channels since the previous run; skipped when there are none\n",
    );
    expect(await workflows('run', 'english')).toMatchObject({
      code: 0,
      stdout:
        'Run 1 of Workflow english skipped: no messages in its history window\n',
    });

    english(
      'history: true\nhistory-messages: all\nhistory-hours: 24\nrun-when-empty: true\n',
    );
    await restart(ws);
    expect((await workflows('show', 'english')).stdout).toContain(
      '  history   all messages in all Channels from the last 24 hours; runs even when there are none\n',
    );
  });

  it('takes the token from PERO_TELEGRAM_BOT_TOKEN in the daemon environment', async () => {
    const run = await pero(withDataDir('run'), {
      env: { PERO_TELEGRAM_BOT_TOKEN: TOKEN },
    });
    expect(run.code).toBe(0);
    // The token is fine; only a chat to serve is missing.
    expect(run.stdout).not.toMatch(/Telegram: .*(token|TOKEN)/);

    await connectedStatus();
    expect(api.callsOf('getMe')[0]?.token).toBe(TOKEN);
    const set = await pero(
      withDataDir('settings', 'set', 'telegram-bot-token'),
      {
        input: OTHER_TOKEN,
      },
    );
    expect(set).toMatchObject({
      code: 0,
      stdout: 'telegram-bot-token is now set (PERO_TELEGRAM_BOT_TOKEN)\n',
      stderr:
        'PERO_TELEGRAM_BOT_TOKEN overrides the stored token while it is set\n',
    });

    expect((await pero(withDataDir('stop'))).code).toBe(0);
    const log = readFileSync(layout.logFile, 'utf8');
    expect(log).not.toContain(TOKEN.split(':')[1]);
    expect(log).not.toContain(OTHER_TOKEN.split(':')[1]);
  });

  it('counts only providers in use and checks sign-in again on run', async () => {
    const ws = useWorkspace();
    expect((await pero(ws('run'))).code).toBe(0);
    const pid = readDaemonMetadata(layout.metadataFile)?.pid;

    writeFileSync(join(authDir, 'claude'), '');
    await pero(ws('settings', 'set', 'telegram-bot-token'), {
      input: TOKEN,
    });
    await pero(ws('telegram', 'allow', '1234'));

    const again = await pero(ws('run'));
    expect(again).toMatchObject({
      code: 0,
      stdout: `Pero is already running (pid ${pid}, workspace ${join(realpathSync(tmp), 'ws')})\n`,
    });
    const ready = await pero(ws('status'));
    expect(ready.stdout).toMatch(/Health +ok/);
    expect(ready.stdout).toMatch(/claude +ok +Signed in \(claude\.ai, pro\)/);
    expect(ready.stdout).toContain(
      'codex     unconfigured  Not signed in — run codex login (on a headless host: codex login --device-auth) (not in use)',
    );
    expect(ready.stdout).not.toContain('owner@example.com');

    // Codex becomes the provider in use; Claude no longer counts.
    writeFileSync(
      join(tmp, 'ws', 'data', 'Settings', 'Pero.md'),
      '---\nprovider: codex\n---\n',
    );
    expect((await pero(ws('stop'))).code).toBe(0);
    const switched = await pero(ws('run'));
    expect(switched.stdout).toContain(
      '  codex: Not signed in — run codex login (on a headless host: codex login --device-auth), then pero run to check again',
    );
    expect(switched.stdout).not.toContain('claude:');
    // Required now: no longer marked not in use.
    expect((await pero(ws('status'))).stdout).toContain(
      'codex     unconfigured  Not signed in — run codex login (on a headless host: codex login --device-auth)\n',
    );
  });

  it('needs the daemon for settings', async () => {
    for (const args of [
      ['settings'],
      ['settings', 'show'],
      ['settings', 'unset', 'telegram-bot-token'],
    ]) {
      expect(await pero(withDataDir(...args))).toMatchObject({
        code: 1,
        stderr: `${NOT_RUNNING}\n`,
      });
    }
  });

  it('keeps the daemon running after the CLI and its process group end', async () => {
    const cli = spawn(process.execPath, [PERO, ...withDataDir('run')], {
      detached: true,
      stdio: 'ignore',
    });
    children.push(cli);
    const code = await new Promise((resolve) => cli.once('exit', resolve));
    expect(code).toBe(0);

    // What closing a terminal does to the jobs it started.
    kill(-cli.pid!, 'SIGKILL');
    kill(-cli.pid!, 'SIGHUP');

    const running = await findRunningDaemon(layout.metadataFile);
    expect(running?.metadata.pid).not.toBe(cli.pid);
    await expect(
      createControlClient(layout.controlSocket).status(),
    ).resolves.toMatchObject({ pid: running?.metadata.pid });
  });

  it('fails a command that needs the daemon without starting one', async () => {
    const result = await pero(withDataDir('ping'));

    expect(result).toMatchObject({
      code: 1,
      stdout: '',
      stderr: `${NOT_RUNNING}\n`,
    });
    expect(existsSync(layout.controlSocket)).toBe(false);
    expect(existsSync(layout.metadataFile)).toBe(false);
  });

  it('reports status of a stopped daemon with exit code 3', async () => {
    const result = await pero(withDataDir('status'));

    expect(result).toMatchObject({
      code: 3,
      stderr: `Pero isn't running (data directory ${layout.root})\n`,
    });
  });

  it('prints why the daemon failed to start and where its logs are', async () => {
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.database, 'not a database'.repeat(100));

    const result = await pero(withDataDir('run'));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Pero failed to start: the daemon exited with code 1.',
    );
    expect(result.stderr).toContain('file is not a database');
    expect(result.stderr).toContain(
      `Logs: ${layout.logFile}, ${layout.daemonOutputFile}`,
    );
    expect(await findRunningDaemon(layout.metadataFile)).toBeNull();
  });

  it('runs in the foreground as one process until SIGTERM', async () => {
    const child = spawn(
      process.execPath,
      [PERO, 'run', '--foreground', ...withDataDir()],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    children.push(child);
    let stdout = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    const exited = new Promise((resolve) =>
      child.once('exit', (code) => resolve(code)),
    );

    await vi.waitFor(
      async () => {
        const running = await findRunningDaemon(layout.metadataFile);
        expect(running?.metadata.pid).toBe(child.pid);
      },
      { timeout: 20_000, interval: 50 },
    );
    const lines = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: 'Pero daemon started' }),
    );

    child.kill('SIGTERM');

    await expect(exited).resolves.toBe(0);
    expect(readdirSync(layout.run)).toEqual(['pero.lock']);
  });

  it('accepts the data directory before or after the command, or from PERO_HOME', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const pid = readDaemonMetadata(layout.metadataFile)?.pid;

    for (const result of [
      await pero(['status', '--data-dir', layout.root]),
      await pero(['status'], { env: { PERO_HOME: layout.root } }),
    ]) {
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(new RegExp(`PID +${pid}\\n`));
    }
  });

  it('finds a workspace from options, PERO_WORKSPACE, or the current folder', async () => {
    const workspace = join(realpathSync(tmp), 'ws');
    const state = dataDirLayout(join(workspace, '.pero'), workspace);
    others.push(state);

    const run = await pero(['run', '-w', workspace]);
    expect(run.code).toBe(0);
    const pid = readDaemonMetadata(state.metadataFile)?.pid;
    expect(run.stdout).toContain(
      `Pero is running (pid ${pid}, workspace ${workspace})`,
    );
    expect(readFileSync(join(workspace, '.pero', '.gitignore'), 'utf8')).toBe(
      STATE_GITIGNORE,
    );
    expect(statSync(state.database).isFile()).toBe(true);

    mkdirSync(join(workspace, 'data', 'Notes'), { recursive: true });
    for (const result of [
      await pero(['--workspace', workspace, 'status']),
      await pero(['status'], { env: { PERO_WORKSPACE: workspace } }),
      await pero(['status'], { cwd: join(workspace, 'data', 'Notes') }),
    ]) {
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(new RegExp(`PID +${pid}\\n`));
      expect(result.stdout).toContain(`  Workspace  ${workspace}\n`);
    }

    expect(await pero(['stop'], { cwd: workspace })).toMatchObject({
      code: 0,
      stdout: 'Pero stopped\n',
    });
    expect(await pero(['status', '-w', workspace])).toMatchObject({
      code: 3,
      stderr: `Pero isn't running (workspace ${workspace})\n`,
    });
    expect(
      await pero(['status', '-w', workspace, '--data-dir', layout.root]),
    ).toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        '--workspace: cannot be combined with --data-dir',
      ),
    });
  });

  it('stops startup on an invalid config.yaml, naming the file, line, and key', async () => {
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(
      layout.configFile,
      'telegram:\n  allowed-chats:\n    - id: family\n',
    );

    const run = await pero(withDataDir('run', '--foreground'));

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      `Invalid ${layout.configFile}:\n  line 3: telegram.allowed-chats (item 1).id: must be a Telegram chat ID`,
    );
    expect(readDaemonMetadata(layout.metadataFile)).toBeNull();
  });

  it('allows and denies chats in config.yaml while Pero is stopped', async () => {
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(
      layout.configFile,
      '# my Pero\ntelegram:\n  allowed-chats: []\n',
    );
    // Without the daemon, and without loading what the daemon needs.
    const nodeArgs = ['--import', DENY_DAEMON_DEPS];
    const notRunning =
      "Pero isn't running; the change is in config.yaml and applies when it starts.\n";

    const allow = await pero(
      withDataDir('telegram', 'allow', '-1001234567890'),
      { nodeArgs },
    );
    expect(allow).toMatchObject({
      code: 0,
      stderr: '',
      stdout: `Allowed: group -1001234567890\n${notRunning}`,
    });
    expect(readFileSync(layout.configFile, 'utf8')).toBe(
      '# my Pero\ntelegram:\n  allowed-chats:\n    - id: -1001234567890\n',
    );

    const deny = await pero(withDataDir('telegram', 'deny', '-1001234567890'), {
      nodeArgs,
    });
    expect(deny).toMatchObject({
      code: 0,
      stderr: '',
      stdout:
        'Denied: group -1001234567890. Its Channels and Agents are kept and resume if you allow it again.\n' +
        notRunning,
    });
    expect(readFileSync(layout.configFile, 'utf8')).toBe(
      '# my Pero\ntelegram:\n  allowed-chats: []\n',
    );
    const again = await pero(withDataDir('telegram', 'deny', '-1001234567890'));
    expect(again).toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        'Telegram chat -1001234567890 is not allowed',
      ),
    });
    expect(existsSync(layout.database)).toBe(false);
  });

  it('makes a workspace with init, and points to it when there is none', async () => {
    const home = join(realpathSync(tmp), 'home');
    mkdirSync(home);
    const env = { HOME: home };
    const workspace = join(home, 'workspace');
    const hint = `No Pero workspace found in this folder or above it, or in ~/workspace. Create one with: pero init ${workspace}\n`;

    expect(await pero(['status'], { env, cwd: home })).toMatchObject({
      code: 3,
      stderr: hint,
    });
    expect(await pero(['run'], { env, cwd: home })).toMatchObject({
      code: 1,
      stderr: hint,
    });
    expect(existsSync(workspace)).toBe(false);

    // Without the daemon, and without loading what the daemon needs.
    const init = await pero(['init', workspace], {
      env,
      nodeArgs: ['--import', DENY_DAEMON_DEPS],
    });
    expect(init).toMatchObject({ code: 0, stderr: '' });
    expect(init.stdout).toBe(
      [
        `Pero workspace ${workspace}:`,
        '  created  .gitignore',
        '  created  .pero/.gitignore',
        '  created  .pero/config.yaml',
        '  created  data/Settings/Pero.md',
        '  created  data/Settings/Agents/Main.md',
        '  created  data/Settings/Agents/_Template.md',
        '  created  data/Settings/Workflows/',
        '',
        `Start Pero there with: cd ${workspace} && pero run`,
        '',
      ].join('\n'),
    );
    const again = await pero(['init'], { env, cwd: workspace });
    expect(again.stdout).toContain(
      `Pero workspace ${workspace} has everything already:\n  kept  .gitignore\n`,
    );

    // From home, ~/workspace is found now, with its data folder set up.
    others.push(dataDirLayout(join(workspace, '.pero'), workspace));
    const run = await pero(['run'], { env, cwd: home });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`, workspace ${workspace})\n`);
    expect(run.stdout).not.toContain('working directory');
    expect(await pero(['stop'], { env, cwd: home })).toMatchObject({
      code: 0,
      stdout: 'Pero stopped\n',
    });
  });

  it('has no migrate command', async () => {
    expect(await pero(['migrate', join(tmp, 'workspace')])).toEqual({
      code: 1,
      stdout: '',
      stderr: "error: unknown command 'migrate'\n",
    });
    expect(existsSync(join(tmp, 'workspace'))).toBe(false);
  });

  it('marks a data directory as legacy', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const status = await pero(withDataDir('status'));
    expect(status.stdout).toContain(
      `  Data directory  ${layout.root} (legacy)\n`,
    );
    expect(existsSync(join(layout.root, '.gitignore'))).toBe(false);
  });

  it('reaches a workspace whose path is too long for a socket in it', async () => {
    const workspace = join(
      realpathSync(tmp),
      'w'.repeat(MAX_SOCKET_PATH_BYTES),
    );
    const runtime = join(tmp, 'runtime');
    mkdirSync(runtime);
    const env = { XDG_RUNTIME_DIR: runtime };
    const state = dataDirLayout(join(workspace, '.pero'), workspace);
    others.push(state);

    expect((await pero(['run', '-w', workspace], { env })).code).toBe(0);
    const socket = readDaemonMetadata(state.metadataFile)?.socket;
    expect(socket?.startsWith(`${runtime}/pero-`)).toBe(true);
    expect(statSync(socket!).isSocket()).toBe(true);

    // The metadata says where the socket is, whatever the environment.
    const status = await pero(['status', '-w', workspace]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(`  Workspace  ${workspace}\n`);
    expect(await pero(['stop', '-w', workspace])).toMatchObject({
      code: 0,
      stdout: 'Pero stopped\n',
    });
    expect(existsSync(socket!)).toBe(false);
  });

  it('shows recent logs readably whether or not the daemon runs', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const running = await pero(withDataDir('logs'));
    expect(running.code).toBe(0);
    expect(running.stdout).toMatch(STARTED_ENTRY);
    expect((await pero(withDataDir('stop'))).code).toBe(0);

    const stopped = await pero(withDataDir('logs'));
    expect(stopped).toMatchObject({ code: 0, stderr: '' });
    expect(stopped.stdout).toMatch(STARTED_ENTRY);
    expect(stopped.stdout).toMatch(/ INFO {2}Pero daemon stopped\n$/);
    expect(stopped.stdout).not.toContain('{"level"');

    const one = await pero(withDataDir('logs', '-n', '1'));
    expect(one.stdout).toMatch(/^[^\n]+ INFO {2}Pero daemon stopped\n$/);

    const json = await pero(withDataDir('logs', '--json', '--lines', '2'));
    const entries = json.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ level: 30, msg: 'Pero daemon stopped' });
  });

  it('reports a missing log directory without creating anything', async () => {
    const result = await pero(withDataDir('logs'));

    expect(result).toMatchObject({
      code: 0,
      stdout: '',
      stderr: `No logs yet in ${layout.logs}\n`,
    });
    expect(existsSync(layout.root)).toBe(false);
  });

  it('follows new entries, from before the log exists until stopped', async () => {
    const follower = spawn(process.execPath, [
      PERO,
      ...withDataDir('logs', '--follow'),
    ]);
    children.push(follower);
    let stdout = '';
    let stderr = '';
    follower.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    follower.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    await vi.waitFor(
      () => expect(stderr).toBe(`Waiting for ${layout.logFile}…\n`),
      FOLLOWER_WAIT,
    );

    expect((await pero(withDataDir('run'))).code).toBe(0);
    await vi.waitFor(
      () => expect(stdout).toMatch(STARTED_ENTRY),
      FOLLOWER_WAIT,
    );
    expect((await pero(withDataDir('stop'))).code).toBe(0);
    await vi.waitFor(
      () => expect(stdout).toMatch(/ INFO {2}Pero daemon stopped\n$/),
      FOLLOWER_WAIT,
    );

    expect(follower.exitCode).toBeNull();
    expect(stdout).not.toContain('{"level"');
  });

  it('rejects a line count that is not a positive whole number', async () => {
    for (const count of ['0', '-3', '1.5', 'many']) {
      const result = await pero(withDataDir('logs', '-n', count));
      expect(result).toMatchObject({
        code: 1,
        stderr: `--lines must be a positive whole number, not "${count}"\n`,
      });
    }
  });

  it('restores a backup into a fresh data directory that starts with the same records', async () => {
    const cwd = realpathSync(tmp);
    const vault = join(cwd, 'vault');
    mkdirSync(vault);
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.configFile, `data: ${vault}\n`);
    const file = join(cwd, 'backup.tgz');
    const nodeArgs = ['--import', DENY_DAEMON_DEPS];

    expect((await pero(withDataDir('run'))).code).toBe(0);
    const set = await pero(
      withDataDir('settings', 'set', 'telegram-bot-token'),
      {
        input: `${TOKEN}\n`,
      },
    );
    expect(set.code).toBe(0);
    const before = await pero(withDataDir('settings'));

    // Taken while the daemon runs, so recent writes are still in the WAL.
    const backup = await pero(withDataDir('backup', 'backup.tgz'), {
      cwd,
      nodeArgs,
    });
    expect(backup).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(
        new RegExp(
          `^Backed up ${escape(layout.root)} to ${escape(file)} \\(\\d+\\.\\d KB\\)\\n` +
            'It contains the Telegram bot token; keep it private, like the data directory\\.\\n$',
        ),
      ),
      stderr: '',
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await pero(withDataDir('stop'))).code).toBe(0);

    rmSync(vault, { recursive: true });
    const restore = await pero(['--data-dir', restored.root, 'restore', file], {
      nodeArgs,
    });
    expect(restore).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(
        new RegExp(
          `^Restored the backup from \\S+ \\(Pero ${escape(PACKAGE_VERSION)}\\) into ${escape(restored.root)}\\.\\n` +
            `Start it with pero run --data-dir ${escape(restored.root)}\\n$`,
        ),
      ),
      stderr: `Warning: ${vault}, the default working directory, is missing; restore it from your own backup of the working folders\n`,
    });
    mkdirSync(vault);

    const run = await pero(['--data-dir', restored.root, 'run']);
    expect(run.code).toBe(0);
    const after = await pero(['--data-dir', restored.root, 'settings']);
    expect(after).toEqual({
      ...before,
      stdout: before.stdout.replace(layout.root, restored.root),
    });
    // The restored token connects the bot.
    await connectedStatus((...args) => ['--data-dir', restored.root, ...args]);
    expect((await pero(['--data-dir', restored.root, 'stop'])).code).toBe(0);

    expect(dumpTables(restored.database)).toEqual(dumpTables(layout.database));
  });

  it('restores a legacy backup into a workspace, and a workspace with its data folder into a clone', async () => {
    const cwd = realpathSync(tmp);
    const ws = join(cwd, 'ws');
    const clone = join(cwd, 'clone');
    others.push(
      dataDirLayout(join(ws, '.pero'), ws),
      dataDirLayout(join(clone, '.pero'), clone),
    );
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const token = await pero(
      withDataDir('settings', 'set', 'telegram-bot-token'),
      {
        input: `${TOKEN}\n`,
      },
    );
    expect(token.code).toBe(0);
    expect(
      (await pero(withDataDir('telegram', 'allow', '-1001234567890'))).code,
    ).toBe(0);
    expect(
      (await pero(withDataDir('backup', 'legacy.tgz'), { cwd })).code,
    ).toBe(0);
    expect((await pero(withDataDir('stop'))).code).toBe(0);

    // The token moves to .env; the workspace's data/ is made when it starts.
    const legacy = await pero(['restore', 'legacy.tgz', '-w', ws], { cwd });
    expect(legacy).toMatchObject({ code: 0, stderr: '' });
    expect(legacy.stdout).toContain(
      `\nWrote the Telegram bot token to ${ws}/.env.\nStart it with pero run --workspace ${ws}\n`,
    );
    expect(readFileSync(join(ws, '.env'), 'utf8')).toBe(
      `PERO_TELEGRAM_BOT_TOKEN=${TOKEN}\n`,
    );
    expect(statSync(join(ws, '.env')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(ws, '.gitignore'), 'utf8')).toBe('.env\n');
    expect(readFileSync(join(ws, '.pero', 'config.yaml'), 'utf8')).toContain(
      '- id: -1001234567890',
    );

    expect((await pero(['run', '-w', ws])).code).toBe(0);
    writeFileSync(join(ws, 'data', 'note.md'), 'Kept safe\n');
    const backup = await pero(
      ['backup', '-w', ws, '--include-data', 'ws.tgz'],
      {
        cwd,
      },
    );
    expect(backup).toMatchObject({ code: 0, stderr: '' });
    expect(backup.stdout).toMatch(
      new RegExp(
        `^Backed up ${escape(join(ws, '.pero'))} and the data folder to ${escape(join(cwd, 'ws.tgz'))} `,
      ),
    );
    expect(backup.stdout).not.toContain('bot token');
    expect((await pero(['stop', '-w', ws])).code).toBe(0);

    // A clone whose config.yaml no longer allows the group.
    mkdirSync(join(clone, '.pero'), { recursive: true });
    writeFileSync(join(clone, '.pero', 'config.yaml'), 'data: data\n');
    const restore = await pero(['restore', 'ws.tgz', '-w', clone], { cwd });
    expect(restore).toMatchObject({ code: 0, stderr: '' });
    expect(restore.stdout.split('\n').slice(1)).toEqual([
      `Kept ${clone}/.pero/config.yaml; the backup's was not used.`,
      "The backup's config.yaml also allowed -1001234567890; allow them again with pero telegram allow <chat-id>.",
      `Restored 1 file of the data folder into ${clone}/data.`,
      `Start it with pero run --workspace ${clone}`,
      '',
    ]);
    expect(readFileSync(join(clone, 'data', 'note.md'), 'utf8')).toBe(
      'Kept safe\n',
    );
    expect(existsSync(join(clone, '.env'))).toBe(false);
  });

  it('refuses to restore over a running Pero or a data directory in use', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const file = join(tmp, 'backup.tgz');
    expect((await pero(withDataDir('backup', file))).code).toBe(0);

    expect(await pero(withDataDir('restore', file))).toMatchObject({
      code: 1,
      stdout: '',
      stderr: `Pero is running for data directory ${layout.root} — stop it with pero stop before restoring\n`,
    });
    expect((await pero(withDataDir('stop'))).code).toBe(0);
    expect(await pero(withDataDir('restore', file))).toMatchObject({
      code: 1,
      stderr: `${layout.root} is not empty. Restore into a new data directory, or stop Pero and move ${layout.root} aside first.\n`,
    });
    expect(
      await pero(['--data-dir', restored.root, 'restore', join(tmp, 'nope')]),
    ).toMatchObject({
      code: 1,
      stderr: `${join(tmp, 'nope')} does not exist\n`,
    });
    expect(existsSync(restored.root)).toBe(false);
  });

  it('needs the daemon for a backup', async () => {
    expect(await pero(withDataDir('backup', join(tmp, 'b.tgz')))).toMatchObject(
      {
        code: 1,
        stderr: `${NOT_RUNNING}\n`,
      },
    );
    expect(existsSync(layout.root)).toBe(false);
  });

  it('never loads the database stack for status, ping, logs, settings, and stop', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const nodeArgs = ['--import', DENY_DAEMON_DEPS];

    for (const command of [
      'status',
      'ping',
      'logs',
      'settings',
      'agents',
      'telegram',
      'stop',
    ]) {
      const result = await pero(withDataDir(command), { nodeArgs });
      expect(result, command).toMatchObject({ code: 0, stderr: '' });
    }
    const follower = spawn(
      process.execPath,
      [...nodeArgs, PERO, ...withDataDir('logs', '--follow')],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    children.push(follower);
    let followed = '';
    follower.stdout!.on('data', (chunk: Buffer) => (followed += chunk));
    await vi.waitFor(
      () => expect(followed).toMatch(STARTED_ENTRY),
      FOLLOWER_WAIT,
    );
    expect(follower.exitCode).toBeNull();
    // The hook itself works: the daemon cannot start under it.
    const foreground = await pero(withDataDir('run', '--foreground'), {
      nodeArgs,
    });
    expect(foreground.code).not.toBe(0);
    expect(foreground.stderr).toContain('The CLI must not load');
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every row of every table, to compare two databases. */
function dumpTables(path: string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true });
  try {
    const tables = db
      .prepare<[], { name: string }>(
        `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' ORDER BY "name"`,
      )
      .all();
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Sends `signal`, ignoring a process or group that is already gone. */
function kill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
