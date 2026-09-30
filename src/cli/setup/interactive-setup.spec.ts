import { beforeEach, describe, expect, it } from 'vitest';
import { parseInput } from '../../common/errors.js';
import { settingsChangeSchema } from '../../config/settings-input.js';
import type { ControlClient } from '../../control/client.js';
import type {
  AllowedChatView,
  ComponentStatus,
  SettingsView,
  StatusResult,
  TelegramChats,
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
    defaultWorkingDirectory: '/home/owner/workspace/data',
    sharedInstructions: null,
    mainAgent: 'main',
    historyCarryover: 50,
    historyRetentionDays: null,
    defaultPermissions: 'ask',
    timezone: 'UTC',
    maxConcurrentRuns: 2,
    telegramBotToken: { set: false, source: null },
    files: { pero: 'data/Settings/Pero.md', config: '.pero/config.yaml' },
    newTopics: 'create-agent',
    setInPero: [],
  };
  signedIn = new Set<string>();
  checks = 0;
  telegram: TelegramChats = {
    bot: 'pero_test_bot',
    allowed: [allowedChat('1234', 'private', 'Ada')],
    pairing: [],
  };
  /** Called before each answer to `telegram.chats`, with its count. */
  onChatsPoll: (poll: number) => void = () => undefined;
  private chatsPolls = 0;

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
      if (op === 'telegram.chats') {
        this.onChatsPoll(++this.chatsPolls);
        return this.telegram;
      }
      if (op === 'telegram.allow') {
        const { chatId } = params as { chatId: string };
        const request = this.telegram.pairing.find((r) => r.chatId === chatId);
        const chat = allowedChat(
          chatId,
          request?.kind ?? 'group',
          request?.title ?? null,
        );
        this.telegram = {
          ...this.telegram,
          allowed: [...this.telegram.allowed, chat],
          pairing: this.telegram.pairing.filter((r) => r.chatId !== chatId),
        };
        return { chat, alreadyAllowed: false };
      }
      if (op !== 'settings.update') throw new Error(`unexpected ${op}`);
      const change = parseInput(settingsChangeSchema, params);
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

function allowedChat(
  chatId: string,
  kind: AllowedChatView['kind'],
  title: string | null,
): AllowedChatView {
  return {
    chatId,
    kind,
    title,
    bot: kind === 'group' ? 'administrator' : null,
    topics: kind === 'group' ? true : null,
    problem: null,
    allowedAt: since,
  };
}

/** An answer that leaves the prompt open until its signal aborts it. */
const WAIT = Symbol('wait');

/** Answers prompts in order and records what was asked. */
function scripted(answers: (string | boolean | typeof WAIT)[]) {
  const asked: string[] = [];
  const next = <T>(
    message: string,
    initial?: string,
    signal?: AbortSignal,
  ): Promise<T> => {
    asked.push(initial === undefined ? message : `${message} [${initial}]`);
    const answer = answers.shift();
    if (answer === undefined) {
      return Promise.reject(
        Object.assign(new Error('closed'), { name: 'ExitPromptError' }),
      );
    }
    if (answer === WAIT) {
      return new Promise((_, reject) => {
        const abort = () =>
          reject(
            Object.assign(new Error('aborted'), { name: 'AbortPromptError' }),
          );
        if (signal?.aborted) abort();
        signal?.addEventListener('abort', abort);
      });
    }
    return Promise.resolve(answer as T);
  };
  const prompts: Prompts = {
    input: ({ message, initial, signal }) => next(message, initial, signal),
    password: ({ message }) => next(`${message} (hidden)`),
    confirm: ({ message }) => next(`${message} (y/n)`),
  };
  return { prompts, asked };
}

describe('runInteractiveSetup', () => {
  let daemon: FakeDaemon;
  let printed: string[];

  beforeEach(() => {
    daemon = new FakeDaemon();
    printed = [];
  });

  function run(answers: (string | boolean | typeof WAIT)[]) {
    const { prompts, asked } = scripted(answers);
    const done = runInteractiveSetup(
      {
        client: daemon.client,
        prompts,
        print: (text) => printed.push(text),
        pollIntervalMs: 5,
      },
      daemon.state(),
    );
    return { done, asked };
  }

  it('asks for the token, and is done once the provider is signed in', async () => {
    daemon.signedIn.add('claude');
    const { done, asked } = run([TOKEN]);
    await done;

    expect(asked).toEqual(['Bot token (Enter to skip) (hidden)']);
    expect(daemon.settings.telegramBotToken.set).toBe(true);
    expect(printed.at(-1)).toBe('Setup complete');
    expect(printed.join('\n')).not.toContain(TOKEN);
  });

  it('asks nothing about folders in a legacy data directory, and says to migrate', async () => {
    daemon.settings = { ...daemon.settings, files: null };
    daemon.signedIn.add('claude');
    const { done, asked } = run([TOKEN]);
    await done;

    expect(asked).toEqual(['Bot token (Enter to skip) (hidden)']);
    expect(printed.at(-1)).toMatch(
      /^Setup needed:\n {2}This legacy data directory has no Agents — pero migrate <workspace>/,
    );
  });

  it('skips the token, and asks again for one that is not valid', async () => {
    daemon.signedIn.add('claude');
    const { done, asked } = run(['nope', '']);
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
    const { done, asked } = run([TOKEN, '', '']);
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
    const { done } = run([TOKEN, 's']);
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
    const { done } = run([TOKEN]);

    await expect(done).rejects.toMatchObject({ name: 'ExitPromptError' });
    expect(daemon.settings.telegramBotToken.set).toBe(true);
  });

  describe('pairing a Telegram chat', () => {
    const WAITING = 'Waiting for a message to @pero_test_bot (Enter to skip)';

    beforeEach(() => {
      daemon.settings = {
        ...daemon.settings,
        telegramBotToken: { set: true, source: 'secrets' },
      };
      daemon.signedIn.add('claude');
      daemon.telegram = { bot: null, allowed: [], pairing: [] };
    });

    function askToPair(poll: number, chatId: string, title: string) {
      daemon.onChatsPoll = (n) => {
        if (n === 2)
          daemon.telegram = { ...daemon.telegram, bot: 'pero_test_bot' };
        if (n !== poll) return;
        daemon.telegram = {
          ...daemon.telegram,
          pairing: [
            {
              chatId,
              kind: chatId.startsWith('-') ? 'group' : 'private',
              title,
              firstSeenAt: since,
              lastSeenAt: since,
            },
          ],
        };
      };
    }

    it('offers a chat that messages the bot during setup, and allows it', async () => {
      askToPair(5, '1234', 'Ada');

      const { done, asked } = run([WAIT, true]);
      await done;

      expect(asked).toEqual([WAITING, 'Allow direct chat "Ada" (1234)? (y/n)']);
      expect(printed).toContain('Waiting for Telegram…');
      expect(printed).toContain('Allowed: direct chat "Ada" (1234)');
      expect(daemon.telegram.allowed.map((chat) => chat.chatId)).toEqual([
        '1234',
      ]);
      expect(printed.at(-1)).toBe('Setup complete');
    });

    it('keeps waiting after a declined chat, and skips on Enter', async () => {
      askToPair(3, '-100555', 'Strangers');

      const { done, asked } = run([false, '']);
      await done;

      expect(asked).toEqual([
        'Allow group "Strangers" (-100555)? (y/n)',
        WAITING,
      ]);
      expect(daemon.telegram.allowed).toEqual([]);
      expect(printed.join('\n')).toContain('Skipped; the bot tells a chat');
      expect(printed.at(-1)).toContain('pero telegram allow -100555');
    });

    it('stops waiting when a chat is allowed some other way', async () => {
      daemon.onChatsPoll = (n) => {
        if (n === 2)
          daemon.telegram = { ...daemon.telegram, bot: 'pero_test_bot' };
        if (n === 4) {
          daemon.telegram = {
            ...daemon.telegram,
            allowed: [allowedChat('-100777', 'group', 'Home')],
          };
        }
      };

      const { done, asked } = run([WAIT]);
      await done;

      expect(asked).toEqual([WAITING]);
      expect(printed.at(-1)).toBe('Setup complete');
    });

    it('skips pairing while a chat is allowed', async () => {
      daemon.telegram = {
        bot: 'pero_test_bot',
        allowed: [allowedChat('1234', 'private', 'Ada')],
        pairing: [],
      };

      const { done, asked } = run([]);
      await done;

      expect(asked).toEqual([]);
      expect(printed.at(-1)).toBe('Setup complete');
    });
  });
});
