import {
  type ChildProcess,
  execFile,
  execFileSync,
  spawn,
} from 'node:child_process';
import {
  cpSync,
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
  MAX_SOCKET_PATH_BYTES,
  STATE_GITIGNORE,
  type WorkspaceLayout,
  workspaceLayout,
} from '../src/config/workspace-layout.js';
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
  /** The temporary folder as the OS names it, shorter than its real path. */
  let shortTmp: string;
  /** Its real path, as Pero resolves a workspace inside it. */
  let tmp: string;
  let layout: WorkspaceLayout;
  /** Where the fake provider CLIs look for their sign-in. */
  let authDir: string;
  /** Other state directories a test started a daemon in. */
  const others: WorkspaceLayout[] = [];
  let api: FakeBotApi;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    api = new FakeBotApi();
    await api.listen();
    // Short: macOS limits socket paths to 104 bytes.
    shortTmp = mkdtempSync(join(tmpdir(), 'pero-'));
    tmp = realpathSync(shortTmp);
    layout = workspaceLayout(join(tmp, 'ws'));
    authDir = join(tmp, 'auth');
    mkdirSync(authDir);
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
    for (const { metadataFile } of [layout, ...others.splice(0)]) {
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
   * `cwd` says otherwise; the environment carries no PERO_WORKSPACE or
   * Telegram token, the fake provider CLIs that
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
    target: (...args: string[]) => string[] = inWorkspace,
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

  /** The arguments that run `pero` in the workspace `tmp/ws`. */
  const inWorkspace = (...args: string[]) => ['-w', layout.workspace, ...args];

  /**
   * Makes `tmp/ws` a workspace with `pero init`'s skeleton, with `notes`
   * by their path in its system folder; returns the arguments that run
   * `pero` there.
   */
  function useWorkspace(
    notes: Record<string, string> = {},
  ): (...args: string[]) => string[] {
    initWorkspace(layout.workspace, tmp);
    for (const [file, text] of Object.entries(notes)) {
      writeFileSync(join(layout.workspace, 'data', 'System', file), text);
    }
    return inWorkspace;
  }

  /** Restarts the daemon of `target`, which then reads its notes again. */
  async function restart(target: (...args: string[]) => string[]) {
    expect((await pero(target('stop'))).code).toBe(0);
    expect((await pero(target('run'))).code).toBe(0);
  }

  it('runs once, reports status, and stops safely twice', async () => {
    const first = await pero(inWorkspace('run'));
    expect(first).toMatchObject({ code: 0, stderr: '' });
    const pid = Number(/\(pid (\d+),/.exec(first.stdout)?.[1]);
    expect(first.stdout).toContain(
      `Pero is running (pid ${pid}, workspace ${layout.workspace})`,
    );
    expect(first.stdout).toContain(
      [
        'Setup needed:',
        '  Telegram: Bot token is not set — pero telegram token (reads it from stdin), or start Pero with PERO_TELEGRAM_BOT_TOKEN',
        '  claude: Not signed in — run claude auth login, then pero run to check again',
        'Run pero run in a terminal to set these up step by step.',
      ].join('\n'),
    );
    // Codex is neither the default provider nor used by a Channel note.
    expect(first.stdout).not.toContain('codex');

    const second = await pero(inWorkspace('run'));
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`Pero is already running (pid ${pid},`);
    expect(readDaemonMetadata(layout.metadataFile)?.pid).toBe(pid);

    const status = await pero(inWorkspace('status'));
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(new RegExp(`PID +${pid}\\n`));
    expect(status.stdout).toMatch(/Health +degraded/);
    for (const name of ['claude', 'codex', 'telegram']) {
      expect(status.stdout).toMatch(new RegExp(`${name} +unconfigured`));
    }
    expect(status.stdout).toMatch(/codex +unconfigured .*\(not in use\)\n/);

    const stop = await pero(inWorkspace('stop'));
    expect(stop).toMatchObject({ code: 0, stdout: 'Pero stopped\n' });
    expect(isAlive(pid)).toBe(false);
    expect(readdirSync(layout.run)).toEqual(['pero.lock']);

    const again = await pero(inWorkspace('stop'));
    expect(again).toMatchObject({
      code: 0,
      stdout: `Pero isn't running (workspace ${layout.workspace})\n`,
    });
  });

  it('sets the bot token without a restart, never showing it', async () => {
    expect((await pero(inWorkspace('run'))).code).toBe(0);
    const pid = readDaemonMetadata(layout.metadataFile)?.pid;
    const before = await pero(inWorkspace('status'));
    expect(before.stdout).toMatch(
      /telegram +unconfigured +Bot token is not set/,
    );
    expect(before.stdout).toMatch(/Health +degraded/);

    const set = await pero(inWorkspace('telegram', 'token'), {
      input: `${TOKEN}\n`,
    });
    expect(set).toMatchObject({
      code: 0,
      stdout: 'Telegram bot token: set (.env)\n',
      stderr: '',
    });

    // Connecting happens in the background, without a restart.
    const status = await connectedStatus();
    expect(status.stdout).toMatch(new RegExp(`PID +${pid}\\n`));
    expect(api.callsOf('getMe')[0]?.token).toBe(TOKEN);
    const show = await pero(inWorkspace('settings'));
    expect(show.code).toBe(0);
    expect(show.stdout).toMatch(/^Telegram bot token: set \(\.env\)$/m);
    expect(statSync(layout.envFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(layout.envFile, 'utf8')).toBe(
      `PERO_TELEGRAM_BOT_TOKEN=${TOKEN}\n`,
    );

    expect((await pero(inWorkspace('stop'))).code).toBe(0);
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

  it('keeps the token in .env, which Git must ignore', async () => {
    const { workspace } = layout;
    const ws = inWorkspace;
    mkdirSync(workspace);
    execFileSync('git', ['init', '-q', workspace]);
    writeFileSync(join(workspace, '.gitignore'), 'node_modules/\n');

    expect((await pero(ws('run'))).code).toBe(0);
    const set = await pero(ws('telegram', 'token'), {
      input: `${TOKEN}\n`,
    });
    expect(set).toMatchObject({
      code: 0,
      stdout: 'Telegram bot token: set (.env)\n',
    });
    const envFile = join(workspace, '.env');
    expect(readFileSync(envFile, 'utf8')).toBe(
      `PERO_TELEGRAM_BOT_TOKEN=${TOKEN}\n`,
    );
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(existsSync(join(layout.stateDir, 'secrets'))).toBe(false);

    // Stored again, the .gitignore line is not added twice.
    await pero(ws('telegram', 'token'), {
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
    const show = await pero(ws('settings'));
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
      readFileSync(layout.logFile, 'utf8'),
      readFileSync(layout.daemonOutputFile, 'utf8'),
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
    expect((await pero(inWorkspace('run'))).code).toBe(0);
    await pero(inWorkspace('telegram', 'token'), {
      input: `${TOKEN}\n`,
    });
    const before = await connectedStatus();
    expect(before.stdout).toMatch(
      /telegram +degraded +Connected as @pero_test_bot; no chat is allowed yet: add the bot to a group or message it, then pero telegram allow <chat-id>\n/,
    );
    const run = await pero(inWorkspace('run'));
    expect(run.stdout).toContain(
      '  Telegram: no chat is allowed yet — add the bot to a group as an administrator or message it, then pero telegram allow <chat-id>',
    );
    expect((await pero(inWorkspace('telegram'))).stdout).toContain(
      'No chat is allowed yet. To pair one:',
    );

    // A group's ID is negative, which must not pass for an option.
    writeFileSync(
      layout.configFile,
      `${readFileSync(layout.configFile, 'utf8')}# my own note\n`,
    );
    const allow = await pero(
      inWorkspace('telegram', 'allow', '-1001234567890'),
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
      '--workspace',
      layout.workspace,
    ]);
    expect(again.stdout).toBe(
      'Already allowed: group "Household" (-1001234567890)\n',
    );
    const chats = await pero(inWorkspace('telegram', 'chats'));
    expect(chats).toMatchObject({ code: 0, stderr: '' });
    expect(chats.stdout).toMatch(/^Bot: @pero_test_bot$/m);
    expect(chats.stdout).toMatch(
      /^ {2}-1001234567890 +group +Household +on +administrator$/m,
    );
    const status = await pero(inWorkspace('status'));
    expect(status.stdout).toMatch(
      /telegram +ok +Connected as @pero_test_bot\n/,
    );

    const deny = await pero(inWorkspace('telegram', 'deny', '-1001234567890'));
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
      inWorkspace('telegram', 'deny', '-1001234567890'),
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(
      'Telegram chat -1001234567890 is not allowed',
    );
    const invalid = await pero(inWorkspace('telegram', 'allow', 'general'));
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain(
      'chat-id: must be a Telegram chat ID, such as -1001234567890 or 123456789',
    );
  });

  it('refuses a token as an argument, and one that is not valid, without echoing either', async () => {
    expect((await pero(inWorkspace('run'))).code).toBe(0);

    const argument = await pero(inWorkspace('telegram', 'token', TOKEN));
    expect(argument).toMatchObject({
      code: 1,
      stdout: '',
      stderr:
        'Give the bot token at the prompt or on stdin, not as an argument, so it stays out of shell history\n',
    });

    const invalid = await pero(inWorkspace('telegram', 'token'), {
      input: 'secret-but-wrong\n',
    });
    expect(invalid).toMatchObject({
      code: 1,
      stdout: '',
      stderr:
        'token: must be a bot token from @BotFather, such as 123456789:AAE…\n',
    });
    expect(await pero(inWorkspace('telegram', 'token'))).toMatchObject({
      code: 1,
      stderr: 'No bot token given\n',
    });
    expect(existsSync(layout.envFile)).toBe(false);
    expect((await pero(inWorkspace('stop'))).code).toBe(0);
    expect(readFileSync(layout.logFile, 'utf8')).not.toContain(
      'secret-but-wrong',
    );
  });

  it('stores the token in .env while Pero is stopped, which uses it from its start', async () => {
    const ws = useWorkspace();

    const set = await pero(ws('telegram', 'token'), { input: `${TOKEN}\n` });
    expect(set).toEqual({
      code: 0,
      stdout:
        "Telegram bot token: set (.env)\nPero isn't running; it uses the token when it starts.\n",
      stderr: '',
    });
    expect(readFileSync(layout.envFile, 'utf8')).toBe(
      `PERO_TELEGRAM_BOT_TOKEN=${TOKEN}\n`,
    );
    expect(statSync(layout.envFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(layout.workspaceGitignore, 'utf8')).toMatch(/^\.env$/m);

    expect((await pero(ws('run'))).code).toBe(0);
    await connectedStatus(ws);
    expect(api.callsOf('getMe')[0]?.token).toBe(TOKEN);
  });

  it('prints its version with -v or --version', async () => {
    for (const flag of ['-v', '--version']) {
      expect(await pero([flag])).toEqual({
        code: 0,
        stdout: `${PACKAGE_VERSION}\n`,
        stderr: '',
      });
    }
    expect(await pero(['-V'])).toMatchObject({
      code: 1,
      stderr: "error: unknown option '-V'\n",
    });
  });

  it('reports a removed command as unknown, whether or not Pero runs', async () => {
    const ws = useWorkspace();
    const unknown = async () => {
      for (const [args, word] of [
        [['agents'], 'agents'],
        [['agents', 'show', 'main'], 'agents'],
        [['channels', 'assign', '1', 'main'], 'assign'],
        [['workflows', 'notify', 'brief', '1'], 'notify'],
        [['triggers', 'ls'], 'triggers'],
        [['ping'], 'ping'],
      ] as const) {
        expect(await pero(ws(...args)), args.join(' ')).toEqual({
          code: 1,
          stdout: '',
          stderr: `error: unknown command '${word}'\n`,
        });
      }
      expect(
        await pero(ws('settings', 'set', 'timezone', 'UTC')),
      ).toMatchObject({
        code: 1,
        stdout: '',
        stderr: expect.stringContaining("too many arguments for 'settings'"),
      });
    };

    await unknown();
    expect((await pero(ws('run'))).code).toBe(0);
    await unknown();
  });

  it('shows the Channel notes and the settings they hold, as they change', async () => {
    const workspace = join(realpathSync(tmp), 'ws');
    const systemFolder = join(workspace, 'data', 'System');
    const state = workspaceLayout(workspace);
    others.push(state);
    expect((await pero(['init', workspace])).code).toBe(0);
    writeFileSync(
      join(systemFolder, 'Pero.md'),
      '---\nclaude-effort: high\ntimezone: Europe/Berlin\n---\n',
    );
    writeFileSync(
      join(systemFolder, 'Channels', 'Health.md'),
      '---\nchannel-id: telegram:-100:7\nmodel: sonnet\npermissions: bypass\nworking-directory: data/Health\n---\nYou coach.\n',
    );
    mkdirSync(join(workspace, 'data', 'Health'));
    writeFileSync(join(systemFolder, 'Channels', 'Garden.md'), 'You garden.\n');
    writeFileSync(
      join(systemFolder, 'Channels', 'Broken.md'),
      '---\nchannel-id: telegram:-100:8\nmodle: opus\n---\n',
    );
    const ws = (...args: string[]) => pero(['-w', workspace, ...args]);
    expect((await ws('run')).code).toBe(0);

    const unused = [
      'Channel notes no Channel Pero has seen uses yet:',
      '  NOTE                            CHANNEL-ID',
      '  data/System/Channels/Garden.md  (none: a topic of its title binds it)',
    ];
    expect(await ws('channels')).toEqual({
      code: 0,
      stdout: [
        'No Channels yet. Allow a Telegram chat with pero telegram allow <chat-id>, then message the bot there or create a topic.',
        '',
        ...unused,
        '  data/System/Channels/Health.md  telegram:-100:7',
        '',
      ].join('\n'),
      stderr: '',
    });

    // Pero has seen the topics both notes name by channel-id.
    expect((await ws('stop')).code).toBe(0);
    const db = new Database(state.database);
    const insert = db.prepare(
      `INSERT INTO "channels" ("integration_kind", "external_key", "address_json", "title") ` +
        `VALUES ('telegram', ?, ?, ?)`,
    );
    insert.run('-100:7', '{"chatId":"-100","topicId":7}', 'Health');
    insert.run('-100:8', '{"chatId":"-100","topicId":8}', 'Broken');
    db.close();
    expect((await ws('run')).code).toBe(0);

    expect(await ws('channels', 'ls')).toEqual({
      code: 0,
      stdout: [
        'ID  CHANNEL          TITLE   NOTE',
        '1   telegram -100:7  Health  data/System/Channels/Health.md',
        '2   telegram -100:8  Broken  none yet (not answering)',
        '',
        ...unused,
        '',
      ].join('\n'),
      stderr: '',
    });
    const show = await ws('channels', 'show', '1');
    expect(show).toMatchObject({ code: 0, stderr: '' });
    expect(show.stdout).toMatch(
      new RegExp(
        `^${escape(
          [
            'Channel 1 "Health"',
            '  address            telegram -100:7',
            '  note               data/System/Channels/Health.md',
            '  provider           claude (default)',
            '  model              sonnet',
            '  effort             high (Pero.md)',
            `  working directory  ${join(workspace, 'data', 'Health')}`,
            '  instructions       You coach.',
            '  permissions        bypass',
            '  codex git check    required',
            '  state              enabled',
            '  next turn          starts its first Session',
            '  history            no messages yet',
            '  created            ',
          ].join('\n'),
        )}\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\n$`,
      ),
    );
    expect(await ws('channels', 'show', '2')).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(
        /^ {2}note {7}none\n[^]*\n\nWarning: Pero doesn't answer here: its note data\/System\/Channels\/Broken\.md has errors\.\n$/m,
      ),
    });

    const settings = await ws('settings');
    expect(settings).toMatchObject({ code: 0, stderr: '' });
    expect(settings.stdout).toContain(
      [
        'data/System/Pero.md',
        '  provider                claude (default)',
        '  claude-model            (provider default)',
        '  claude-effort           high',
      ].join('\n'),
    );
    expect(settings.stdout).toMatch(/^ {2}timezone +Europe\/Berlin$/m);
    expect(settings.stdout).toContain(
      `.pero/config.yaml\n  data                    ${join(workspace, 'data')}\n`,
    );

    // An edit to Pero.md applies within a rescan.
    writeFileSync(
      join(systemFolder, 'Pero.md'),
      '---\nclaude-effort: low\n---\n',
    );
    await vi.waitFor(
      async () =>
        expect((await ws('channels', 'show', '1')).stdout).toContain(
          '  effort             low (Pero.md)\n',
        ),
      { timeout: 15_000, interval: 500 },
    );
    expect((await ws('stop')).code).toBe(0);
  }, 30_000);

  it('lists and shows Channels, and prints their history', async () => {
    const ws = useWorkspace();
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
    await pero(ws('telegram', 'token'), {
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
        'ID  CHANNEL                     TITLE      NOTE\n' +
        '1   telegram -1001234567890:42  Groceries  data/System/Channels/Groceries.md\n',
      stderr: '',
    });
    const show = await channels('show', '1');
    expect(show.code).toBe(0);
    expect(show.stdout).toMatch(/^Channel 1 "Groceries"\n/);
    expect(show.stdout).toMatch(/^ {2}next turn +starts its first Session$/m);
    expect(show.stdout).toMatch(/^ {2}history +1 message, the latest at /m);

    const history = await channels('history', '1', '-n', '5');
    expect(history.code).toBe(0);
    expect(history.stdout).toMatch(
      /^\d{4}-\d\d-\d\d \d\d:\d\d {2}out {2}pero {2}Pero answers in this topic with claude, default model, /,
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

    // A Workflow note posts its runs to the topic, by its Channel note.
    expect(
      readFileSync(
        join(tmp, 'ws', 'data', 'System', 'Channels', 'Groceries.md'),
        'utf8',
      ),
    ).toContain('channel-id: telegram:-1001234567890:42\n');
    writeFileSync(
      join(tmp, 'ws', 'data', 'System', 'Workflows', 'Brief.md'),
      '---\nchannel: Groceries\n---\nGo\n',
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
  });

  it('lists and shows the Workflows notes define', async () => {
    const ws = useWorkspace({
      'Pero.md': '---\ntimezone: Europe/Berlin\n---\n',
    });
    const workflows = (...args: string[]) => pero(ws('workflows', ...args));
    expect((await pero(ws('run'))).code).toBe(0);
    expect(await workflows()).toMatchObject({
      code: 0,
      stdout:
        'No Workflows yet. Add a note to the Workflows folder in the system folder.\n',
    });

    writeFileSync(
      join(tmp, 'ws', 'data', 'System', 'Workflows', 'Evening review.md'),
      "---\nhour: 21\n---\nReview today's chats.\n",
    );
    await restart(ws);
    const listed = await workflows();
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(
      new RegExp(
        [
          'NAME +CHANNEL NOTE +SCHEDULE +NEXT RUN +CHANNELS +STATE +NOTE',
          'evening-review +default +0 21 \\* \\* \\* \\(Europe/Berlin\\) +\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d +— +enabled +data/System/Workflows/Evening review\\.md',
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
          '  note          data/System/Workflows/Evening review\\.md',
          '  channel note  default',
          "  input         Review today's chats\\.",
          '  schedule      0 21 \\* \\* \\* \\(Europe/Berlin\\)',
          '  next run      \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d',
          '  last run      never',
        ].join('\n'),
      ),
    );
    expect(shown.stdout).toMatch(
      /\n\nPosts to no Channel: name a Channel note in channel in its note to post its answers there\.\n$/,
    );
    expect(await workflows('show', 'nothing')).toMatchObject({
      code: 1,
      stderr: 'No Workflow named nothing\n',
    });

    writeFileSync(
      join(tmp, 'ws', 'data', 'System', 'Channels', 'Default.md'),
      '---\nenabled: false\n---\n',
    );
    await restart(ws);
    expect((await workflows('show', 'evening-review')).stdout).toContain(
      '\nWarning: Channel note default is disabled, so this Workflow cannot run until it is enabled again (enabled: true in that note).\n',
    );
  });

  it('runs a Workflow by hand and prints its answer', async () => {
    const ws = useWorkspace({
      'Workflows/Brief.md':
        '---\nhour: 9\nmax-attempts: 3\n---\nSummarize the day.\n',
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
      '  attempts      up to 3 (a run Pero stops starts again when Pero does)\n',
    );
  });

  it('lists, shows, and retries runs and Notifications', async () => {
    const echo = { env: { PERO_FAKE_RUNTIME: 'echo' } };
    const ws = useWorkspace({
      'Workflows/Brief.md': 'Summarize the day.\n',
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
        join(tmp, 'ws', 'data', 'System', 'Workflows', 'English.md'),
        `---\n${properties}---\nSuggest improvements: {{history}}\n`,
      );
    const ws = useWorkspace();
    const echo = { env: { PERO_FAKE_RUNTIME: 'echo' } };
    english('history: true\nhistory-channels: 7\n');
    expect((await pero(ws('run'), echo)).code).toBe(0);
    const workflows = (...args: string[]) => pero(ws('workflows', ...args));

    expect(await workflows('show', 'english')).toMatchObject({
      code: 1,
      stderr:
        "Workflow english isn't loaded: data/System/Workflows/English.md has errors; pero check lists them\n",
    });
    expect((await pero(ws('check'))).stdout).toContain(
      'history-channels: no Channel has the ID 7',
    );

    english('history: true\n');
    await restart(ws);
    expect((await workflows('show', 'english')).stdout).toContain(
      "  history       people's messages in all Channels since the previous run; skipped when there are none\n",
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
      '  history       all messages in all Channels from the last 24 hours; runs even when there are none\n',
    );
  });

  it('takes the token from PERO_TELEGRAM_BOT_TOKEN in the daemon environment', async () => {
    const run = await pero(inWorkspace('run'), {
      env: { PERO_TELEGRAM_BOT_TOKEN: TOKEN },
    });
    expect(run.code).toBe(0);
    // The token is fine; only a chat to serve is missing.
    expect(run.stdout).not.toMatch(/Telegram: .*(token|TOKEN)/);

    await connectedStatus();
    expect(api.callsOf('getMe')[0]?.token).toBe(TOKEN);
    const set = await pero(inWorkspace('telegram', 'token'), {
      input: OTHER_TOKEN,
    });
    expect(set).toMatchObject({
      code: 0,
      stdout: 'Telegram bot token: set (PERO_TELEGRAM_BOT_TOKEN)\n',
      stderr:
        'PERO_TELEGRAM_BOT_TOKEN overrides the stored token while it is set\n',
    });

    expect((await pero(inWorkspace('stop'))).code).toBe(0);
    const log = readFileSync(layout.logFile, 'utf8');
    expect(log).not.toContain(TOKEN.split(':')[1]);
    expect(log).not.toContain(OTHER_TOKEN.split(':')[1]);
  });

  it('counts only providers in use and checks sign-in again on run', async () => {
    const ws = useWorkspace();
    expect((await pero(ws('run'))).code).toBe(0);
    const pid = readDaemonMetadata(layout.metadataFile)?.pid;

    writeFileSync(join(authDir, 'claude'), '');
    await pero(ws('telegram', 'token'), {
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
      join(tmp, 'ws', 'data', 'System', 'Pero.md'),
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
    expect(await pero(inWorkspace('settings'))).toMatchObject({
      code: 1,
      stderr: `${NOT_RUNNING}\n`,
    });
  });

  it('keeps the daemon running after the CLI and its process group end', async () => {
    const cli = spawn(process.execPath, [PERO, ...inWorkspace('run')], {
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
    const result = await pero(inWorkspace('channels'));

    expect(result).toMatchObject({
      code: 1,
      stdout: '',
      stderr: `${NOT_RUNNING}\n`,
    });
    expect(existsSync(layout.controlSocket)).toBe(false);
    expect(existsSync(layout.metadataFile)).toBe(false);
  });

  it('reports status of a stopped daemon with exit code 3', async () => {
    const result = await pero(inWorkspace('status'));

    expect(result).toMatchObject({
      code: 3,
      stderr: `Pero isn't running (workspace ${layout.workspace})\n`,
    });
  });

  it('prints why the daemon failed to start and where its logs are', async () => {
    mkdirSync(layout.stateDir, { recursive: true });
    writeFileSync(layout.database, 'not a database'.repeat(100));

    const result = await pero(inWorkspace('run'));

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
      [PERO, 'run', '--foreground', ...inWorkspace()],
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

  it('finds a workspace from options, PERO_WORKSPACE, or the current folder', async () => {
    const workspace = join(realpathSync(tmp), 'ws');
    const state = workspaceLayout(workspace);
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
    // Only a workspace: PERO_HOME names none, and --data-dir is no option.
    expect(
      await pero(['status'], { env: { HOME: tmp, PERO_HOME: state.stateDir } }),
    ).toMatchObject({
      code: 3,
      stderr: expect.stringContaining('No Pero workspace found'),
    });
    expect(
      await pero(['status', '-w', workspace, '--data-dir', state.stateDir]),
    ).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("unknown option '--data-dir'"),
    });
  });

  it('stops startup on an invalid config.yaml, naming the file, line, and key', async () => {
    mkdirSync(layout.stateDir, { recursive: true });
    writeFileSync(
      layout.configFile,
      'telegram:\n  allowed-chats:\n    - id: family\n',
    );

    const run = await pero(inWorkspace('run', '--foreground'));

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      `Invalid ${layout.configFile}:\n  line 3: telegram.allowed-chats (item 1).id: must be a Telegram chat ID`,
    );
    expect(readDaemonMetadata(layout.metadataFile)).toBeNull();
  });

  it('allows and denies chats in config.yaml while Pero is stopped', async () => {
    mkdirSync(layout.stateDir, { recursive: true });
    writeFileSync(
      layout.configFile,
      '# my Pero\ntelegram:\n  allowed-chats: []\n',
    );
    // Without the daemon, and without loading what the daemon needs.
    const nodeArgs = ['--import', DENY_DAEMON_DEPS];
    const notRunning =
      "Pero isn't running; the change is in config.yaml and applies when it starts.\n";

    const allow = await pero(
      inWorkspace('telegram', 'allow', '-1001234567890'),
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

    const deny = await pero(inWorkspace('telegram', 'deny', '-1001234567890'), {
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
    const again = await pero(inWorkspace('telegram', 'deny', '-1001234567890'));
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
        '  created  data/System/Pero.md',
        '  created  data/System/Persona.md',
        '  created  data/System/Instructions.md',
        '  created  data/System/Channels/Default.md',
        '  created  data/System/Workflows/',
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
    others.push(workspaceLayout(workspace));
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

  it('reaches a workspace whose path is too long for a socket in it', async () => {
    const workspace = join(
      realpathSync(tmp),
      'w'.repeat(MAX_SOCKET_PATH_BYTES),
    );
    // Not the real path, which on macOS is too long for the socket too.
    const runtime = join(shortTmp, 'runtime');
    mkdirSync(runtime);
    const env = { XDG_RUNTIME_DIR: runtime };
    const state = workspaceLayout(workspace);
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
    expect((await pero(inWorkspace('run'))).code).toBe(0);
    const running = await pero(inWorkspace('logs'));
    expect(running.code).toBe(0);
    expect(running.stdout).toMatch(STARTED_ENTRY);
    expect((await pero(inWorkspace('stop'))).code).toBe(0);

    const stopped = await pero(inWorkspace('logs'));
    expect(stopped).toMatchObject({ code: 0, stderr: '' });
    expect(stopped.stdout).toMatch(STARTED_ENTRY);
    expect(stopped.stdout).toMatch(/ INFO {2}Pero daemon stopped\n$/);
    expect(stopped.stdout).not.toContain('{"level"');

    const one = await pero(inWorkspace('logs', '-n', '1'));
    expect(one.stdout).toMatch(/^[^\n]+ INFO {2}Pero daemon stopped\n$/);

    const json = await pero(inWorkspace('logs', '--json', '--lines', '2'));
    const entries = json.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ level: 30, msg: 'Pero daemon stopped' });
  });

  it('reports a missing log directory without creating anything', async () => {
    const result = await pero(inWorkspace('logs'));

    expect(result).toMatchObject({
      code: 0,
      stdout: '',
      stderr: `No logs yet in ${layout.logs}\n`,
    });
    expect(existsSync(layout.stateDir)).toBe(false);
  });

  it('follows new entries, from before the log exists until stopped', async () => {
    const follower = spawn(process.execPath, [
      PERO,
      ...inWorkspace('logs', '--follow'),
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

    expect((await pero(inWorkspace('run'))).code).toBe(0);
    await vi.waitFor(
      () => expect(stdout).toMatch(STARTED_ENTRY),
      FOLLOWER_WAIT,
    );
    expect((await pero(inWorkspace('stop'))).code).toBe(0);
    await vi.waitFor(
      () => expect(stdout).toMatch(/ INFO {2}Pero daemon stopped\n$/),
      FOLLOWER_WAIT,
    );

    expect(follower.exitCode).toBeNull();
    expect(stdout).not.toContain('{"level"');
  });

  it('rejects a line count that is not a positive whole number', async () => {
    for (const count of ['0', '-3', '1.5', 'many']) {
      const result = await pero(inWorkspace('logs', '-n', count));
      expect(result).toMatchObject({
        code: 1,
        stderr: `--lines must be a positive whole number, not "${count}"\n`,
      });
    }
  });

  it('restores a backup into a fresh workspace that starts with the same records', async () => {
    const cwd = realpathSync(tmp);
    const ws = useWorkspace();
    const source = join(cwd, 'ws');
    const fresh = join(cwd, 'fresh');
    const freshLayout = workspaceLayout(fresh);
    others.push(freshLayout);
    const file = join(cwd, 'backup.tgz');
    const nodeArgs = ['--import', DENY_DAEMON_DEPS];

    expect((await pero(ws('run'))).code).toBe(0);
    const set = await pero(ws('telegram', 'token'), {
      input: `${TOKEN}\n`,
    });
    expect(set.code).toBe(0);
    const before = await pero(ws('settings'));

    // Taken while the daemon runs, so recent writes are still in the WAL.
    const backup = await pero(ws('backup', 'backup.tgz'), { cwd, nodeArgs });
    expect(backup).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(
        new RegExp(
          `^Backed up ${escape(layout.stateDir)} to ${escape(file)} \\(\\d+\\.\\d KB\\)\\n$`,
        ),
      ),
      stderr: '',
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await pero(ws('stop'))).code).toBe(0);

    const restore = await pero(['restore', file, '-w', fresh], { nodeArgs });
    expect(restore).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(
        new RegExp(
          `^Restored the backup from \\S+ \\(Pero ${escape(PACKAGE_VERSION)}\\) into ${escape(freshLayout.stateDir)}\\.\\n` +
            `Start it with pero run --workspace ${escape(fresh)}\\n$`,
        ),
      ),
      stderr: `Warning: ${fresh}/data, the data folder, is missing; restore it from your Git repository or your own backup\n`,
    });
    // The data folder comes from Git, and the token is written again.
    cpSync(join(source, 'data'), join(fresh, 'data'), { recursive: true });
    writeFileSync(join(fresh, '.env'), `PERO_TELEGRAM_BOT_TOKEN=${TOKEN}\n`, {
      mode: 0o600,
    });

    const target = (...args: string[]) => ['-w', fresh, ...args];
    expect((await pero(target('run'))).code).toBe(0);
    const after = await pero(target('settings'));
    expect(after).toEqual({
      ...before,
      stdout: before.stdout.replaceAll(source, fresh),
    });
    await connectedStatus(target);
    expect((await pero(target('stop'))).code).toBe(0);

    expect(dumpTables(freshLayout.database)).toEqual(
      dumpTables(layout.database),
    );
  });

  it('restores a workspace with its data folder into a clone', async () => {
    const cwd = realpathSync(tmp);
    const ws = useWorkspace();
    const source = join(cwd, 'ws');
    const clone = join(cwd, 'clone');
    others.push(workspaceLayout(clone));
    expect((await pero(ws('run'))).code).toBe(0);
    const token = await pero(ws('telegram', 'token'), {
      input: `${TOKEN}\n`,
    });
    expect(token.code).toBe(0);
    expect((await pero(ws('telegram', 'allow', '-1001234567890'))).code).toBe(
      0,
    );
    writeFileSync(join(source, 'data', 'note.md'), 'Kept safe\n');
    const backup = await pero(ws('backup', '--include-data', 'ws.tgz'), {
      cwd,
    });
    expect(backup).toMatchObject({ code: 0, stderr: '' });
    expect(backup.stdout).toMatch(
      new RegExp(
        `^Backed up ${escape(layout.stateDir)} and the data folder to ${escape(join(cwd, 'ws.tgz'))} `,
      ),
    );
    expect((await pero(ws('stop'))).code).toBe(0);

    // A clone with what Git has: the notes, and a config.yaml that no
    // longer allows the group.
    mkdirSync(join(clone, '.pero'), { recursive: true });
    writeFileSync(join(clone, '.pero', 'config.yaml'), 'data: data\n');
    cpSync(join(source, 'data'), join(clone, 'data'), { recursive: true });
    rmSync(join(clone, 'data', 'note.md'));
    const inGit = readdirSync(join(clone, 'data'), {
      recursive: true,
      withFileTypes: true,
    }).filter((entry) => entry.isFile()).length;
    const restore = await pero(['restore', 'ws.tgz', '-w', clone], { cwd });
    expect(restore).toMatchObject({ code: 0, stderr: '' });
    expect(restore.stdout.split('\n').slice(1)).toEqual([
      `Kept ${clone}/.pero/config.yaml; the backup's was not used.`,
      "The backup's config.yaml also allowed -1001234567890; allow them again with pero telegram allow <chat-id>.",
      `Restored 1 file of the data folder into ${clone}/data, keeping ${inGit} already there.`,
      `Start it with pero run --workspace ${clone}`,
      '',
    ]);
    expect(readFileSync(join(clone, 'data', 'note.md'), 'utf8')).toBe(
      'Kept safe\n',
    );
    expect(existsSync(join(clone, '.env'))).toBe(false);
  });

  it('refuses to restore over a running Pero or a workspace with a database', async () => {
    const ws = useWorkspace();
    const source = join(realpathSync(tmp), 'ws');
    expect((await pero(ws('run'))).code).toBe(0);
    const file = join(tmp, 'backup.tgz');
    expect((await pero(ws('backup', file))).code).toBe(0);

    expect(await pero(ws('restore', file))).toMatchObject({
      code: 1,
      stdout: '',
      stderr: `Pero is running for workspace ${source} — stop it with pero stop before restoring\n`,
    });
    expect((await pero(ws('stop'))).code).toBe(0);
    expect(await pero(ws('restore', file))).toMatchObject({
      code: 1,
      stderr: `${layout.stateDir} already has a database. Restore into a workspace without one, such as a fresh clone, or stop Pero and move ${layout.database} aside first.\n`,
    });
    const fresh = join(tmp, 'fresh');
    expect(
      await pero(['restore', join(tmp, 'nope'), '-w', fresh]),
    ).toMatchObject({
      code: 1,
      stderr: `${join(tmp, 'nope')} does not exist\n`,
    });
    expect(existsSync(fresh)).toBe(false);
  });

  it('needs the daemon for a backup', async () => {
    expect(await pero(inWorkspace('backup', join(tmp, 'b.tgz')))).toMatchObject(
      {
        code: 1,
        stderr: `${NOT_RUNNING}\n`,
      },
    );
    expect(existsSync(layout.stateDir)).toBe(false);
  });

  it('never loads the database stack for status, logs, settings, and stop', async () => {
    expect((await pero(inWorkspace('run'))).code).toBe(0);
    const nodeArgs = ['--import', DENY_DAEMON_DEPS];

    for (const command of [
      'status',
      'logs',
      'settings',
      'channels',
      'telegram',
      'stop',
    ]) {
      const result = await pero(inWorkspace(command), { nodeArgs });
      expect(result, command).toMatchObject({ code: 0, stderr: '' });
    }
    const follower = spawn(
      process.execPath,
      [...nodeArgs, PERO, ...inWorkspace('logs', '--follow')],
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
    const foreground = await pero(inWorkspace('run', '--foreground'), {
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
