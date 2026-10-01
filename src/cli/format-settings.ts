import { TELEGRAM_TOKEN_ENV } from '../config/settings-input.js';
import type { SettingsView } from '../control/protocol.js';
import { legacyHint } from '../settings-files/note-hints.js';
import { table } from './format-status.js';
import { preview } from './preview.js';

/**
 * `pero settings show`. In a workspace: the `Pero.md` properties, each
 * marked when it is Pero's own default, then `config.yaml`'s data folder
 * and the bot token. In the legacy data directory `dataDir`: that it needs
 * a workspace, and the bot token.
 */
export function formatSettings(view: SettingsView, dataDir: string): string {
  if (view.files === null) {
    return [
      legacyHint(dataDir),
      `Telegram bot token: ${formatToken(view)}`,
    ].join('\n');
  }
  const set = new Set(view.setInPero ?? []);
  const value = (property: string, shown: string) =>
    set.has(property) ? shown : `${shown} (default)`;
  const option = (provider: 'claude' | 'codex', name: 'model' | 'effort') => {
    const chosen = view.providerDefaults[provider][name];
    return chosen === null
      ? '(provider default)'
      : value(`${provider}-${name}`, chosen);
  };
  const rows = table([
    ['provider', value('provider', view.defaultProvider)],
    ['claude-model', option('claude', 'model')],
    ['claude-effort', option('claude', 'effort')],
    ['codex-model', option('codex', 'model')],
    ['codex-effort', option('codex', 'effort')],
    ['permissions', value('permissions', view.defaultPermissions)],
    ['timezone', value('timezone', view.timezone)],
    ['main-agent', value('main-agent', view.mainAgent ?? 'main')],
    ['new-topics', value('new-topics', view.newTopics ?? 'create-agent')],
    [
      'history-carryover',
      value(
        'history-carryover',
        view.historyCarryover === 0 ? '0 (off)' : String(view.historyCarryover),
      ),
    ],
    [
      'history-retention-days',
      value(
        'history-retention-days',
        view.historyRetentionDays === null
          ? 'keep all'
          : String(view.historyRetentionDays),
      ),
    ],
    [
      'max-concurrent-runs',
      value('max-concurrent-runs', String(view.maxConcurrentRuns)),
    ],
    ['(body)', preview(view.sharedInstructions)],
    ['data', view.defaultWorkingDirectory ?? '(not set)'],
  ]);
  return [
    view.files.pero,
    ...rows.slice(0, 13).map((row) => `  ${row}`),
    view.files.config,
    `  ${rows[13]}`,
    `Telegram bot token: ${formatToken(view)}`,
  ].join('\n');
}

/** Whether the bot token is set, and where it comes from; never the token. */
export function formatToken({ telegramBotToken }: SettingsView): string {
  const { set, source } = telegramBotToken;
  const from =
    source === 'environment'
      ? TELEGRAM_TOKEN_ENV
      : source === 'env-file'
        ? '.env'
        : source;
  if (set) return `set (${from})`;
  return from ? `not valid (${from})` : 'not set';
}
