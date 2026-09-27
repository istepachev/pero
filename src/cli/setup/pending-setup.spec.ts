import { describe, expect, it } from 'vitest';
import type {
  ComponentStatus,
  SettingsView,
  StatusResult,
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
    dataDir: '/home/owner/.pero',
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
  defaultWorkingDirectory: null,
  sharedInstructions: null,
  timezone: 'UTC',
  maxConcurrentRuns: 2,
  telegramBotToken: { set: false, source: null },
};

describe('pendingSetup', () => {
  it('lists the folder, Telegram, and providers in use', () => {
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
        '  Default working directory is not set — pero settings set default-working-directory <folder>',
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
          component('telegram', 'ok', 'Bot token is set'),
        ]),
        { ...settings, defaultWorkingDirectory: '/home/owner/notes' },
      ),
    ).toEqual([]);
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
});
