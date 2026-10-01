import { describe, expect, it } from 'vitest';
import type {
  ComponentStatus,
  SettingsView,
  StatusResult,
  TelegramChats,
} from '../../control/protocol.js';
import { formatPendingSetup, pendingSetup } from './pending-setup.js';

const since = '2026-09-28T10:00:00.000Z';

function component(
  name: string,
  state: ComponentStatus['state'],
  detail: string | null,
  required = true,
): ComponentStatus {
  return { name, state, detail, since, required };
}

function status(components: ComponentStatus[]): StatusResult {
  return {
    pid: 1,
    version: '0.0.0',
    workspace: '/home/owner/workspace',
    stateDir: '/home/owner/workspace/.pero',
    startedAt: since,
    uptimeMs: 0,
    health: 'degraded',
    components,
  };
}

const settings: SettingsView = {
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

describe('pendingSetup', () => {
  it('lists Telegram and the providers in use', () => {
    const pending = pendingSetup(
      status([
        component(
          'claude',
          'unconfigured',
          'Not signed in — run claude auth login',
        ),
        component('codex', 'unconfigured', 'Not signed in', false),
        component('telegram', 'unconfigured', 'Bot token is not set'),
      ]),
      settings,
    );

    expect(formatPendingSetup(pending)).toBe(
      [
        'Setup needed:',
        '  Telegram: Bot token is not set — pero settings set telegram-bot-token (reads it from stdin), or start Pero with PERO_TELEGRAM_BOT_TOKEN',
        '  claude: Not signed in — run claude auth login, then pero run to check again',
        'Run pero run in a terminal to set these up step by step.',
      ].join('\n'),
    );
  });

  it('is empty once everything in use is ready', () => {
    expect(
      pendingSetup(
        status([
          component('claude', 'ok', 'Signed in'),
          component('codex', 'degraded', 'Timed out', false),
          component('telegram', 'ok', 'Connected as @pero_bot'),
        ]),
        {
          ...settings,
          defaultWorkingDirectory: '/home/owner/notes',
          telegramBotToken: { set: true, source: 'env-file' },
        },
      ),
    ).toEqual([]);
  });

  it('leaves out a Telegram connection that is starting or failing', () => {
    expect(
      pendingSetup(
        status([
          component('claude', 'ok', 'Signed in'),
          component('telegram', 'degraded', 'Connecting to Telegram'),
        ]),
        {
          ...settings,
          defaultWorkingDirectory: '/home/owner/notes',
          telegramBotToken: { set: true, source: 'env-file' },
        },
      ),
    ).toEqual([]);
  });

  it('asks for another token once Telegram rejects the one set', () => {
    const [item] = pendingSetup(
      status([
        component('claude', 'ok', 'Signed in'),
        component(
          'telegram',
          'unconfigured',
          'Telegram rejected the bot token',
        ),
      ]),
      {
        ...settings,
        defaultWorkingDirectory: '/home/owner/notes',
        telegramBotToken: { set: true, source: 'env-file' },
      },
    );

    expect(item?.message).toBe(
      'Telegram: Telegram rejected the bot token — pero settings set telegram-bot-token (reads it from stdin), or start Pero with PERO_TELEGRAM_BOT_TOKEN',
    );
  });

  it('points at the environment when its token is not valid', () => {
    const [item] = pendingSetup(
      status([
        component(
          'telegram',
          'degraded',
          'PERO_TELEGRAM_BOT_TOKEN is not a valid bot token',
        ),
      ]),
      {
        ...settings,
        defaultWorkingDirectory: '/home/owner/notes',
        telegramBotToken: { set: false, source: 'environment' },
      },
    );

    expect(item?.message).toBe(
      'Telegram: PERO_TELEGRAM_BOT_TOKEN is not a valid bot token — start Pero with a valid PERO_TELEGRAM_BOT_TOKEN',
    );
  });

  describe('with Telegram connected', () => {
    const ready = status([
      component('claude', 'ok', 'Signed in'),
      component('telegram', 'degraded', 'Connected as @pero_bot; no chat…'),
    ]);
    const configured: SettingsView = {
      ...settings,
      defaultWorkingDirectory: '/home/owner/notes',
      telegramBotToken: { set: true, source: 'env-file' },
    };
    const none: TelegramChats = { bot: 'pero_bot', allowed: [], pairing: [] };

    it('asks for a chat while none is allowed', () => {
      expect(pendingSetup(ready, configured, none)).toEqual([
        {
          name: 'telegram-chat',
          message:
            'Telegram: no chat is allowed yet — add the bot to a group as an administrator or message it, then pero telegram allow <chat-id>',
        },
      ]);
    });

    it('names the latest chat that asked to pair', () => {
      const [item] = pendingSetup(ready, configured, {
        ...none,
        pairing: [
          {
            chatId: '-100555',
            kind: 'group',
            title: 'Home',
            firstSeenAt: since,
            lastSeenAt: since,
          },
        ],
      });

      expect(item?.message).toBe(
        'Telegram: no chat is allowed yet — pero telegram allow -100555 allows the group "Home" (-100555) that asked to pair',
      );
    });

    it('needs nothing once a chat is allowed, or from a daemon that cannot list them', () => {
      const allowed: TelegramChats = {
        ...none,
        allowed: [
          {
            chatId: '1234',
            kind: 'private',
            title: 'Ada',
            bot: null,
            topics: null,
            problem: null,
            allowedAt: since,
          },
        ],
      };

      expect(pendingSetup(ready, configured, allowed)).toEqual([]);
      expect(pendingSetup(ready, configured, null)).toEqual([]);
    });
  });
});
