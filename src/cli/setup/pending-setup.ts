import { PROVIDERS } from '../../config/provider-options.js';
import { TELEGRAM_TOKEN_ENV } from '../../config/settings-input.js';
import type { SettingsView, StatusResult } from '../../control/protocol.js';

/** Something the owner still has to set up, and how. */
export interface PendingSetup {
  name: string;
  /** One line: what is missing, then the command that fixes it. */
  message: string;
}

/**
 * What stands between the daemon and a working installation: the default
 * working directory, the Telegram bot token, and sign-in for each provider
 * in use. Providers no Agent uses are left out.
 */
export function pendingSetup(
  status: StatusResult,
  settings: SettingsView,
): PendingSetup[] {
  const pending: PendingSetup[] = [];
  if (settings.defaultWorkingDirectory === null) {
    pending.push({
      name: 'default-working-directory',
      message:
        'Default working directory is not set — pero settings set default-working-directory <folder>',
    });
  }

  const component = (name: string) =>
    status.components.find((candidate) => candidate.name === name);
  // Only a missing or rejected token needs setup; a connection that is
  // still starting or failing for a while shows in `pero status`.
  const telegram = component('telegram');
  if (
    telegram &&
    (!settings.telegramBotToken.set || telegram.state === 'unconfigured')
  ) {
    pending.push({
      name: 'telegram',
      message:
        settings.telegramBotToken.source === 'environment'
          ? `Telegram: ${telegram.detail} — start Pero with a valid ${TELEGRAM_TOKEN_ENV}`
          : `Telegram: ${telegram.detail ?? 'not set up'} — pero settings set telegram-bot-token (reads it from stdin), or start Pero with ${TELEGRAM_TOKEN_ENV}`,
    });
  }

  for (const provider of PROVIDERS) {
    const state = component(provider);
    if (!state || !state.required || state.state === 'ok') continue;
    pending.push({
      name: provider,
      message: `${provider}: ${state.detail ?? state.state}, then pero run to check again`,
    });
  }
  return pending;
}

/** `pending` as `pero run` prints it, followed by `hint`. */
export function formatPendingSetup(
  pending: PendingSetup[],
  hint = 'Run pero run in a terminal to set these up step by step.',
): string {
  return [
    'Setup needed:',
    ...pending.map((item) => `  ${item.message}`),
    hint,
  ].join('\n');
}
