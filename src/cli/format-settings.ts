import type { SettingsView } from '../control/protocol.js';
import { table } from './format-status.js';
import { findSettingsKey, preview, SETTINGS_KEYS } from './settings-keys.js';

/**
 * `pero settings show`. In a workspace: the `Pero.md` properties, each
 * marked when it is Pero's own default, then `config.yaml`'s data folder
 * and the bot token. In a legacy data directory: each setting by its key.
 */
export function formatSettings(view: SettingsView): string {
  if (view.files === null) {
    return table(SETTINGS_KEYS.map((key) => [key.name, key.show(view)])).join(
      '\n',
    );
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
    `Telegram bot token: ${findSettingsKey('telegram-bot-token').show(view)}`,
  ].join('\n');
}
