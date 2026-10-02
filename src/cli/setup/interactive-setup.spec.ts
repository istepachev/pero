import { beforeEach, describe, expect, it } from 'vitest';
import { parseInput } from '../../common/errors.js';
import { CONTROL_OPERATIONS, ControlError } from '../../control/protocol.js';
import type { ControlClient } from '../../control/client.js';
import type {
  AllowedChatView,
  ComponentStatus,
  SettingsView,
  StatusResult,
  TelegramChats,
} from '../../control/protocol.js';
import type { Prompts } from '../prompts.js';
import { BlockOutput } from './block-output.js';
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
    dataFolder: '/home/owner/workspace/data',
    historyCarryover: 50,
    historyRetentionDays: null,
    defaultPermissions: 'ask',
    timezone: 'UTC',
    maxConcurrentRuns: 2,
    telegramBotToken: { set: false, source: null },
    files: { pero: 'data/System/Pero.md', config: '.pero/config.yaml' },
    setInPero: [],
  };
  signedIn = new Set<string>();
  checks = 0;
  telegram: TelegramChats = {
    bot: 'pero_test_bot',
    allowed: [allowedChat('1234', 'private', 'Ada')],
    pairing: [],
  };
  /** How Telegram stands in a group allowed here. */
  allowAs: Partial<AllowedChatView> = {};
  /** Called when an allowed chat is allowed again, which checks it again. */
  onRecheck: (chat: AllowedChatView) => AllowedChatView = (chat) => chat;
  /** How often setup said it waits to allow a chat. */
  watches = 0;
  /** Whether the daemon predates `telegram.watchPairing`. */
  old = false;
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
      workspace: '/tmp/ws',
      stateDir: '/tmp/ws/.pero',
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
      if (op === 'telegram.watchPairing') {
        if (this.old) {
          throw new ControlError(
            'unknown_operation',
            `Unknown operation: ${op}`,
          );
        }
        this.watches += 1;
        return {};
      }
      if (op === 'telegram.allow') {
        const { chatId } = params as { chatId: string };
        const existing = this.telegram.allowed.find((c) => c.chatId === chatId);
        if (existing) {
          const chat = this.onRecheck(existing);
          this.telegram = {
            ...this.telegram,
            allowed: this.telegram.allowed.map((c) =>
              c.chatId === chatId ? chat : c,
            ),
          };
          return { chat, alreadyAllowed: true };
        }
        const request = this.telegram.pairing.find((r) => r.chatId === chatId);
        const chat = {
          ...allowedChat(
            chatId,
            request?.kind ?? 'group',
            request?.title ?? null,
          ),
          ...this.allowAs,
        };
        this.telegram = {
          ...this.telegram,
          allowed: [...this.telegram.allowed, chat],
          pairing: this.telegram.pairing.filter((r) => r.chatId !== chatId),
        };
        return { chat, alreadyAllowed: false };
      }
      if (op !== 'telegram.token') throw new Error(`unexpected ${op}`);
      parseInput(CONTROL_OPERATIONS['telegram.token'].params, params);
      this.settings = {
        ...this.settings,
        telegramBotToken: { set: true, source: 'env-file' },
      };
      return this.settings.telegramBotToken;
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
    danger: null,
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
    select: ({ message }) => next(`${message} (select)`),
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
    const { done, asked } = run(['', '', TOKEN]);
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
    const { done } = run(['s', TOKEN]);
    await done;

    expect(daemon.checks).toBe(0);
    expect(printed.at(-1)).toContain(
      'claude: Not signed in — run claude login, then pero run to check again',
    );
    expect(printed.at(-1)).toMatch(
      /\nRun pero run again to finish setting up\.$/,
    );
  });

  it('asks about sign-in before Telegram', async () => {
    const { done, asked } = run(['s', '']);
    await done;

    expect(asked).toEqual([
      'Sign in in another terminal, then press Enter to check again (s to skip)',
      'Bot token (Enter to skip) (hidden)',
    ]);
    expect(printed[0]).toBe(
      'Default provider: claude (change with provider: codex in data/System/Pero.md)',
    );
  });

  it('says nothing about providers that are signed in', async () => {
    daemon.signedIn.add('claude');
    const { done } = run([TOKEN]);
    await done;

    expect(printed.join('\n')).not.toContain('provider');
  });

  it('separates each step from the next with an empty line', async () => {
    daemon.telegram = { bot: 'pero_test_bot', allowed: [], pairing: [] };
    const { prompts } = scripted(['s', TOKEN, 'group', '']);
    const output: string[] = [];
    const blocks = new BlockOutput((text) => output.push(text));
    await runInteractiveSetup(
      {
        client: daemon.client,
        prompts: blocks.prompts(prompts),
        print: blocks.print,
        block: blocks.block,
        pollIntervalMs: 5,
      },
      daemon.state(),
    );

    const text = output.join('\n');
    expect(text).toMatch(/^Default provider: claude .*\nclaude: Not signed in/);
    expect(text).toContain('\n\nPero talks to you through a Telegram bot.');
    expect(text).toContain(
      'paste the token it gives you.\n\nSet up the group in Telegram:',
    );
    expect(text).toMatch(/\n\nSetup needed:\n/);
  });

  it('stops when a prompt is closed, keeping what was set', async () => {
    daemon.signedIn.add('claude');
    daemon.telegram = { bot: 'pero_test_bot', allowed: [], pairing: [] };
    const { done } = run([TOKEN]);

    await expect(done).rejects.toMatchObject({ name: 'ExitPromptError' });
    expect(daemon.settings.telegramBotToken.set).toBe(true);
  });

  describe('pairing a Telegram chat', () => {
    const WAITING = 'Waiting for a message to @pero_test_bot (Enter to skip)';
    const CHOICE = 'Where will you talk to Pero? (select)';

    beforeEach(() => {
      daemon.settings = {
        ...daemon.settings,
        telegramBotToken: { set: true, source: 'env-file' },
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

      const { done, asked } = run(['direct', WAIT, true]);
      await done;

      expect(asked).toEqual([
        CHOICE,
        WAITING,
        'Allow direct chat "Ada" (1234)? (y/n)',
      ]);
      expect(printed).toContain(
        'Open @pero_test_bot in Telegram (https://t.me/pero_test_bot) and send it a message.',
      );
      expect(printed.join('\n')).not.toContain('Topics');
      expect(printed).toContain('Waiting for Telegram…');
      expect(printed).toContain('Allowed: direct chat "Ada" (1234)');
      expect(daemon.telegram.allowed.map((chat) => chat.chatId)).toEqual([
        '1234',
      ]);
      expect(printed.at(-1)).toBe('Setup complete');
      // Each look while waiting tells the daemon, so the chat that asks is
      // told in Telegram to confirm here.
      expect(daemon.watches).toBeGreaterThan(0);
    });

    it('still pairs through a daemon too old to hear that setup waits', async () => {
      daemon.old = true;
      askToPair(5, '1234', 'Ada');

      const { done, asked } = run(['direct', WAIT, true]);
      await done;

      expect(asked.at(-1)).toBe('Allow direct chat "Ada" (1234)? (y/n)');
      expect(daemon.telegram.allowed.map((chat) => chat.chatId)).toEqual([
        '1234',
      ]);
    });

    it('keeps waiting after a declined chat, and skips on Enter', async () => {
      askToPair(3, '-100555', 'Strangers');

      const { done, asked } = run(['group', false, '']);
      await done;

      expect(printed).toContain('Set up the group in Telegram:');
      expect(printed).toContain('  2. In the group settings, turn on Topics.');
      expect(asked).toEqual([
        CHOICE,
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

      const { done, asked } = run(['group', WAIT]);
      await done;

      expect(asked).toEqual([CHOICE, WAITING]);
      expect(printed.at(-1)).toBe('Setup complete');
    });

    it('waits for the bot to become an administrator of a group it allows', async () => {
      askToPair(3, '-100777', 'Home');
      daemon.allowAs = { bot: 'member' };
      const promote = daemon.onChatsPoll;
      daemon.onChatsPoll = (n) => {
        promote(n);
        if (n === 7) {
          daemon.telegram = {
            ...daemon.telegram,
            allowed: daemon.telegram.allowed.map((chat) => ({
              ...chat,
              bot: 'administrator',
            })),
          };
        }
      };

      const { done, asked } = run(['group', true, WAIT]);
      await done;

      expect(asked).toEqual([
        CHOICE,
        'Allow group "Home" (-100777)? (y/n)',
        'Waiting for @pero_test_bot to become an administrator (Enter to skip)',
      ]);
      expect(printed).toContain(
        'Make @pero_test_bot an administrator of group "Home" (-100777) (group settings → Administrators → Add Admin), so it sees every message there.',
      );
      expect(printed).toContain(
        '@pero_test_bot is an administrator of group "Home" (-100777).',
      );
      // Only once the group is set up.
      expect(
        printed.indexOf(
          'Pero posted your first steps there. Reply to start talking to Pero.',
        ),
      ).toBe(
        printed.indexOf(
          '@pero_test_bot is an administrator of group "Home" (-100777).',
        ) + 1,
      );
      expect(printed.at(-1)).toBe('Setup complete');
    });

    it('lists the bot as an administrator still to make when skipped', async () => {
      daemon.telegram = {
        bot: 'pero_test_bot',
        allowed: [
          { ...allowedChat('-100777', 'group', 'Home'), bot: 'member' },
        ],
        pairing: [],
      };

      const { done, asked } = run(['']);
      await done;

      expect(asked).toEqual([
        'Waiting for @pero_test_bot to become an administrator (Enter to skip)',
      ]);
      expect(printed).toContain(
        'Skipped; until @pero_test_bot is an administrator, Telegram shows it only commands, mentions, and replies there.',
      );
      expect(printed.at(-1)).toContain(
        'Telegram: the bot is not an administrator of group "Home" (-100777) — make it one',
      );
    });

    it('shows the danger of a public group, and checks again until it is private', async () => {
      const danger =
        'Home (-100777) is a public group (@home): anyone can find it, join, and talk to Pero';
      daemon.telegram = {
        bot: 'pero_test_bot',
        allowed: [{ ...allowedChat('-100777', 'group', 'Home'), danger }],
        pairing: [],
      };
      let checks = 0;
      daemon.onRecheck = (chat) =>
        ++checks === 2 ? { ...chat, danger: null } : chat;

      const { done, asked } = run(['', '']);
      await done;

      expect(asked).toEqual([
        'Make the group private, then press Enter to check again (s to skip)',
        'Make the group private, then press Enter to check again (s to skip)',
      ]);
      expect(printed).toContain(`Danger: ${danger}`);
      expect(printed).toContain('Still public: group "Home" (-100777)');
      expect(printed).toContain('group "Home" (-100777) is private now.');
      expect(printed.at(-1)).toBe('Setup complete');
    });

    it('lets the owner keep a public group, listing it as still to fix', async () => {
      daemon.telegram = {
        bot: 'pero_test_bot',
        allowed: [
          {
            ...allowedChat('-100777', 'group', 'Home'),
            danger: 'Home (-100777) is a public group (@home)',
          },
        ],
        pairing: [],
      };

      const { done } = run(['s']);
      await done;

      expect(printed).toContain(
        'Skipped; anyone can still join group "Home" (-100777). Make it private, or pero telegram deny -100777',
      );
      expect(printed.at(-1)).toContain(
        'Telegram: group "Home" (-100777) is public, so anyone can join it and talk to Pero',
      );
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
