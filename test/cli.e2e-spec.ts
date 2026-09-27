import { type ChildProcess, execFile, spawn } from 'node:child_process';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataDirLayout, type DataDirLayout } from '../src/config/data-dir.js';
import { PACKAGE_VERSION } from '../src/common/package-version.js';
import { createControlClient } from '../src/control/client.js';
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
  const children: ChildProcess[] = [];

  beforeEach(() => {
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
    for (const { metadataFile } of [layout, restored]) {
      const metadata = readDaemonMetadata(metadataFile);
      if (metadata) {
        kill(metadata.pid, 'SIGKILL');
        await vi.waitFor(() => expect(isAlive(metadata.pid)).toBe(false));
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Runs `pero` to completion with `input` on stdin; the environment
   * carries no PERO_HOME or Telegram token, and the fake provider CLIs
   * that the daemon inherits read their sign-in from `authDir`.
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
      PERO_TELEGRAM_BOT_TOKEN: _token,
      ...env
    } = process.env;
    return new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [...(options.nodeArgs ?? []), PERO, ...args],
        {
          env: { ...env, PERO_FAKE_AUTH_DIR: authDir, ...options.env },
          ...(options.cwd ? { cwd: options.cwd } : {}),
        },
        (error, stdout, stderr) => {
          const code = error ? (error.code as number | null) : 0;
          resolve({ code, stdout, stderr });
        },
      );
      child.stdin!.end(options.input ?? '');
    });
  }

  const withDataDir = (...args: string[]) => [
    '--data-dir',
    layout.root,
    ...args,
  ];

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
        '  Default working directory is not set — pero settings set default-working-directory <folder>',
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

    const status = await pero(withDataDir('status'));
    expect(status.stdout).toMatch(new RegExp(`PID +${pid}\\n`));
    expect(status.stdout).toMatch(/telegram +ok +Bot token is set\n/);
    const show = await pero(withDataDir('settings', 'show'));
    expect(show.code).toBe(0);
    expect(show.stdout).toMatch(/^telegram-bot-token +set \(secrets\)$/m);
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

  it('changes and clears settings through the daemon', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    // The CLI sees the real path where the temporary folder is a link.
    const cwd = realpathSync(tmp);
    mkdirSync(join(cwd, 'vault'));

    const settings = (...args: string[]) =>
      pero(withDataDir('settings', ...args), { cwd });

    expect(
      await settings('set', 'default-working-directory', 'vault'),
    ).toMatchObject({
      code: 0,
      stdout: `default-working-directory is now ${join(cwd, 'vault')}\n`,
    });
    expect(
      await settings('set', 'default-working-directory', 'missing'),
    ).toMatchObject({
      code: 1,
      stderr: `Working directory ${join(cwd, 'missing')} does not exist\n`,
    });
    expect(await settings('unset', 'default-working-directory')).toMatchObject({
      code: 1,
      stderr:
        'default-working-directory cannot be unset; set another folder instead\n',
    });
    expect(
      await settings('set', 'claude.model', 'claude-opus-5-5'),
    ).toMatchObject({
      code: 0,
      stdout: 'claude.model is now claude-opus-5-5\n',
    });
    expect(await settings('unset', 'claude.model')).toMatchObject({
      code: 0,
      stdout: 'claude.model is now (provider default)\n',
    });
    expect(await settings('set', 'default-provider', 'gemini')).toMatchObject({
      code: 1,
      stderr:
        'default-provider: Invalid option: expected one of "claude"|"codex"\n',
    });
    expect(await settings('set', 'nope', 'x')).toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/^Unknown setting "nope"\. Settings: /),
    });
    const instructions = await pero(
      withDataDir('settings', 'set', 'shared-instructions'),
      { input: 'Be brief.\nAnswer in English.\n' },
    );
    expect(instructions.stdout).toBe(
      'shared-instructions is now Be brief. (2 lines)\n',
    );

    const show = await settings();
    expect(show.code).toBe(0);
    expect(show.stdout).toMatch(
      new RegExp(`^default-working-directory +${join(cwd, 'vault')}$`, 'm'),
    );
    expect(show.stdout).toMatch(/^claude\.model +\(provider default\)$/m);
    expect(show.stdout).toMatch(/^telegram-bot-token +not set$/m);
  });

  it('takes the token from PERO_TELEGRAM_BOT_TOKEN in the daemon environment', async () => {
    const run = await pero(withDataDir('run'), {
      env: { PERO_TELEGRAM_BOT_TOKEN: TOKEN },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain('Telegram');

    const status = await pero(withDataDir('status'));
    expect(status.stdout).toMatch(
      /telegram +ok +Bot token is set \(from PERO_TELEGRAM_BOT_TOKEN\)/,
    );
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
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const pid = readDaemonMetadata(layout.metadataFile)?.pid;

    writeFileSync(join(authDir, 'claude'), '');
    mkdirSync(join(tmp, 'vault'));
    await pero(
      withDataDir(
        'settings',
        'set',
        'default-working-directory',
        join(tmp, 'vault'),
      ),
    );
    await pero(withDataDir('settings', 'set', 'telegram-bot-token'), {
      input: TOKEN,
    });

    const again = await pero(withDataDir('run'));
    expect(again).toMatchObject({
      code: 0,
      stdout: `Pero is already running (pid ${pid}, data directory ${layout.root})\n`,
    });
    const ready = await pero(withDataDir('status'));
    expect(ready.stdout).toMatch(/Health +ok/);
    expect(ready.stdout).toMatch(/claude +ok +Signed in \(claude\.ai, pro\)/);
    expect(ready.stdout).toContain(
      'codex     unconfigured  Not signed in — run codex login (on a headless host: codex login --device-auth) (not in use)',
    );
    expect(ready.stdout).not.toContain('owner@example.com');

    // Codex becomes the provider in use; Claude no longer counts.
    await pero(withDataDir('settings', 'set', 'default-provider', 'codex'));
    const switched = await pero(withDataDir('run'));
    expect(switched.stdout).toContain(
      '  codex: Not signed in — run codex login (on a headless host: codex login --device-auth), then pero run to check again',
    );
    expect(switched.stdout).not.toContain('claude:');
    expect((await pero(withDataDir('status'))).stdout).toMatch(
      /Health +degraded/,
    );
  });

  it('needs the daemon for settings', async () => {
    for (const args of [
      ['settings'],
      ['settings', 'show'],
      ['settings', 'set', 'timezone', 'UTC'],
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
    await vi.waitFor(() =>
      expect(stderr).toBe(`Waiting for ${layout.logFile}…\n`),
    );

    expect((await pero(withDataDir('run'))).code).toBe(0);
    await vi.waitFor(() => expect(stdout).toMatch(STARTED_ENTRY));
    expect((await pero(withDataDir('stop'))).code).toBe(0);
    await vi.waitFor(() =>
      expect(stdout).toMatch(/ INFO {2}Pero daemon stopped\n$/),
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
    const own = join(cwd, 'own');
    mkdirSync(vault);
    mkdirSync(own);
    const file = join(cwd, 'backup.tgz');
    const nodeArgs = ['--import', DENY_DAEMON_DEPS];

    // Agents have no commands yet: add one while Pero is stopped.
    expect((await pero(withDataDir('run'))).code).toBe(0);
    expect((await pero(withDataDir('stop'))).code).toBe(0);
    const db = new Database(layout.database);
    db.prepare(
      `INSERT INTO "agents" ("name", "provider", "provider_options", "working_directory", "tool_policy_json") ` +
        `VALUES ('coder', 'claude', '{"model":null,"effort":null}', ?, '{}')`,
    ).run(own);
    db.close();

    expect((await pero(withDataDir('run'))).code).toBe(0);
    const settings = [
      ['default-working-directory', vault],
      ['timezone', 'Europe/Lisbon'],
      ['claude.model', 'claude-opus-5-5'],
    ];
    for (const [key, value] of settings) {
      expect(
        (await pero(withDataDir('settings', 'set', key!, value!))).code,
      ).toBe(0);
    }
    for (const [key, input] of [
      ['shared-instructions', 'Be brief.\n'],
      ['telegram-bot-token', `${TOKEN}\n`],
    ]) {
      const set = await pero(withDataDir('settings', 'set', key!), { input });
      expect(set.code).toBe(0);
    }
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

    rmSync(own, { recursive: true });
    const restore = await pero(['--data-dir', restored.root, 'restore', file], {
      nodeArgs,
    });
    expect(restore).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(
        new RegExp(
          `^Restored the backup from \\S+ \\(Pero ${escape(PACKAGE_VERSION)}\\) into ${escape(restored.root)}\\. ` +
            `Start it with pero run --data-dir ${escape(restored.root)}\\n$`,
        ),
      ),
      stderr: `Warning: ${own}, the working directory of Agent coder, is missing; restore it from your own backup of the working folders\n`,
    });
    mkdirSync(own);

    const run = await pero(['--data-dir', restored.root, 'run']);
    expect(run.code).toBe(0);
    const after = await pero(['--data-dir', restored.root, 'settings']);
    expect(after).toEqual(before);
    const status = await pero(['--data-dir', restored.root, 'status']);
    expect(status.stdout).toMatch(/telegram +ok +Bot token is set\n/);
    expect((await pero(['--data-dir', restored.root, 'stop'])).code).toBe(0);

    expect(dumpTables(restored.database)).toEqual(dumpTables(layout.database));
  });

  it('refuses to restore over a running Pero or a data directory in use', async () => {
    expect((await pero(withDataDir('run'))).code).toBe(0);
    const file = join(tmp, 'backup.tgz');
    expect((await pero(withDataDir('backup', file))).code).toBe(0);

    expect(await pero(withDataDir('restore', file))).toMatchObject({
      code: 1,
      stdout: '',
      stderr: `Pero is running for ${layout.root} — stop it with pero stop before restoring\n`,
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

    for (const command of ['status', 'ping', 'logs', 'settings', 'stop']) {
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
    await vi.waitFor(() => expect(followed).toMatch(STARTED_ENTRY));
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
