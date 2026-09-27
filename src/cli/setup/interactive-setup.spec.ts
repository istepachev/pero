import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseInput } from '../../common/errors.js';
import { settingsChangeSchema } from '../../config/settings-input.js';
import { validateWorkingDirectory } from '../../config/working-directory.js';
import type { ControlClient } from '../../control/client.js';
import type {
  ComponentStatus,
  SettingsView,
  StatusResult,
} from '../../control/protocol.js';
import type { Prompts } from '../prompts.js';
import { runInteractiveSetup, type SetupState } from './interactive-setup.js';

const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';
const since = '2026-09-28T10:00:00.000Z';

/** A daemon in memory, validating like the real one. */
class FakeDaemon {
  settings: SettingsView = {
    defaultProvider: 'claude',
    providerDefaults: {
      claude: { model: null, effort: null },
      codex: { model: null, effort: null },
    },
    defaultWorkingDirectory: null,
    sharedInstructions: null,
    timezone: 'UTC',
    maxConcurrentRuns: 2,
    telegramBotToken: { set: false, source: null },
  };
  signedIn = new Set<string>();
  checks = 0;

  status(): StatusResult {
    const provider = (name: string, required: boolean): ComponentStatus => ({
      name,
      state: this.signedIn.has(name) ? 'ok' : 'unconfigured',
      detail: this.signedIn.has(name)
        ? 'Signed in (claude.ai, pro)'
        : `Not signed in — run ${name} login`,
      since,
      required,
    });
    return {
      pid: 1,
      version: '0.0.0',
      dataDir: '/tmp/pero',
      startedAt: since,
      uptimeMs: 0,
      health: 'degraded',
      components: [
        provider('claude', true),
        provider('codex', false),
        {
          name: 'telegram',
          state: this.settings.telegramBotToken.set ? 'ok' : 'unconfigured',
          detail: this.settings.telegramBotToken.set
            ? 'Bot token is set'
            : 'Bot token is not set',
          since,
          required: true,
        },
      ],
    };
  }

  state(): SetupState {
    return { status: this.status(), settings: this.settings };
  }

  readonly client = {
    status: async () => this.status(),
    call: async (op: string, params?: unknown) => {
      if (op === 'providers.check') {
        this.checks += 1;
        return this.status();
      }
      if (op !== 'settings.update') throw new Error(`unexpected ${op}`);
      const change = parseInput(settingsChangeSchema, params);
      if (change.defaultWorkingDirectory !== undefined) {
        this.settings = {
          ...this.settings,
          defaultWorkingDirectory: await validateWorkingDirectory(
            change.defaultWorkingDirectory,
          ),
        };
      }
      if (change.telegramBotToken) {
        this.settings = {
          ...this.settings,
          telegramBotToken: { set: true, source: 'secrets' },
        };
      }
      return this.settings;
    },
  } as unknown as ControlClient;
}

/** Answers prompts in order and records what was asked. */
function scripted(answers: string[]) {
  const asked: string[] = [];
  const next = (message: string, initial?: string) => {
    asked.push(initial === undefined ? message : `${message} [${initial}]`);
    const answer = answers.shift();
    if (answer === undefined) {
      return Promise.reject(
        Object.assign(new Error('closed'), { name: 'ExitPromptError' }),
      );
    }
    return Promise.resolve(answer);
  };
  const prompts: Prompts = {
    input: ({ message, initial }) => next(message, initial),
    password: ({ message }) => next(`${message} (hidden)`),
  };
  return { prompts, asked };
}

describe('runInteractiveSetup', () => {
  let tmp: string;
  let home: string;
  let daemon: FakeDaemon;
  let printed: string[];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-setup-'));
    home = join(tmp, 'home');
    mkdirSync(home);
    daemon = new FakeDaemon();
    printed = [];
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function run(answers: string[], cwd = home) {
    const { prompts, asked } = scripted(answers);
    const done = runInteractiveSetup(
      {
        client: daemon.client,
        prompts,
        cwd,
        home,
        print: (text) => printed.push(text),
      },
      daemon.state(),
    );
    return { done, asked };
  }

  it('suggests ~/workspace from home and creates it', async () => {
    daemon.signedIn.add('claude');
    const { done, asked } = run(['', TOKEN]);
    await done;

    const workspace = join(home, 'workspace');
    expect(asked).toEqual([
      `Working folder [${workspace}]`,
      'Bot token (Enter to skip) (hidden)',
    ]);
    expect(existsSync(workspace)).toBe(true);
    expect(printed).toContain(`Created ${workspace}`);
    expect(daemon.settings.defaultWorkingDirectory).toBe(workspace);
    expect(daemon.settings.telegramBotToken.set).toBe(true);
    expect(printed.at(-1)).toBe('Setup complete');
    expect(printed.join('\n')).not.toContain(TOKEN);
  });

  it('suggests the folder it was started from', async () => {
    const notes = join(home, 'notes');
    mkdirSync(notes);
    daemon.signedIn.add('claude');
    const { done, asked } = run(['', ''], notes);
    await done;

    expect(asked[0]).toBe(`Working folder [${notes}]`);
    expect(daemon.settings.defaultWorkingDirectory).toBe(notes);
    expect(printed).not.toContain(`Created ${notes}`);
  });

  it('asks again for a folder the daemon refuses', async () => {
    const file = join(home, 'file');
    writeFileSync(file, '');
    daemon.signedIn.add('claude');
    const { done } = run([file, '~/vault', '']);
    await done;

    expect(printed).toContain(`Working directory ${file} is not a folder`);
    expect(daemon.settings.defaultWorkingDirectory).toBe(join(home, 'vault'));
  });

  it('skips the token, and asks again for one that is not valid', async () => {
    daemon.signedIn.add('claude');
    const { done, asked } = run(['', 'nope', '']);
    await done;

    expect(asked.filter((q) => q.startsWith('Bot token'))).toHaveLength(2);
    expect(printed).toContain(
      'That is not a bot token from @BotFather (such as 123456789:AAE…); try again.',
    );
    expect(printed).not.toContain('nope');
    expect(daemon.settings.telegramBotToken.set).toBe(false);
    expect(printed.at(-1)).toMatch(/^Setup needed:\n {2}Telegram: /);
  });

  it('checks sign-in again until the provider in use is ready', async () => {
    const { done, asked } = run(['', TOKEN, '', '']);
    // Signs in between the first and second check.
    const original = daemon.client.call.bind(daemon.client);
    (daemon.client as { call: unknown }).call = (
      op: string,
      params?: unknown,
    ) => {
      if (op === 'providers.check' && daemon.checks === 1) {
        daemon.signedIn.add('claude');
      }
      return original(op as never, params as never);
    };
    await done;

    expect(daemon.checks).toBe(2);
    expect(
      asked.filter((q) => q.startsWith('Sign in in another terminal')),
    ).toHaveLength(2);
    expect(printed).toContain('claude: Not signed in — run claude login');
    expect(printed).toContain('claude: Signed in (claude.ai, pro)');
    // Codex is not in use, so it is never asked about.
    expect(printed.join('\n')).not.toContain('codex:');
    expect(printed.at(-1)).toBe('Setup complete');
  });

  it('lets the owner skip a sign-in', async () => {
    const { done } = run(['', TOKEN, 's']);
    await done;

    expect(daemon.checks).toBe(0);
    expect(printed.at(-1)).toContain(
      'claude: Not signed in — run claude login, then pero run to check again',
    );
    expect(printed.at(-1)).toMatch(
      /\nRun pero run again to finish setting up\.$/,
    );
  });

  it('stops when a prompt is closed, keeping what was set', async () => {
    const { done } = run(['']);

    await expect(done).rejects.toMatchObject({ name: 'ExitPromptError' });
    expect(daemon.settings.defaultWorkingDirectory).toBe(
      join(home, 'workspace'),
    );
  });
});
