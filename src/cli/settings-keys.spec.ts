import { describe, expect, it } from 'vitest';
import type { SettingsView } from '../control/protocol.js';
import { CliError } from './errors.js';
import { formatSettings } from './format-settings.js';
import {
  findSettingsKey,
  renameField,
  SETTINGS_KEYS,
} from './settings-keys.js';

const context = { cwd: '/home/owner/notes', home: '/home/owner' };

const view: SettingsView = {
  defaultProvider: 'claude',
  providerDefaults: {
    claude: { model: 'claude-opus-5-5', effort: null },
    codex: { model: null, effort: 'high' },
  },
  defaultWorkingDirectory: null,
  sharedInstructions: null,
  mainAgent: null,
  historyCarryover: 50,
  historyRetentionDays: null,
  defaultPermissions: 'ask',
  timezone: 'Europe/Berlin',
  maxConcurrentRuns: 2,
  telegramBotToken: { set: false, source: null },
};

const set = (name: string, value: string) =>
  findSettingsKey(name).set(value, context);

describe('settings keys', () => {
  it('turns each key into the change it makes', () => {
    expect(set('default-provider', 'codex')).toEqual({
      defaultProvider: 'codex',
    });
    expect(set('claude.model', 'claude-sonnet-5')).toEqual({
      providerDefaults: { claude: { model: 'claude-sonnet-5' } },
    });
    expect(set('codex.effort', 'low')).toEqual({
      providerDefaults: { codex: { effort: 'low' } },
    });
    expect(set('shared-instructions', 'Be brief.\nBe kind.')).toEqual({
      sharedInstructions: 'Be brief.\nBe kind.',
    });
    expect(set('main-agent', 'Coach')).toEqual({ mainAgent: 'Coach' });
    expect(set('timezone', 'utc')).toEqual({ timezone: 'utc' });
    expect(set('history-carryover', '0')).toEqual({ historyCarryover: 0 });
    expect(set('history-retention-days', '30')).toEqual({
      historyRetentionDays: 30,
    });
    expect(set('default-permissions', 'bypass')).toEqual({
      defaultPermissions: 'bypass',
    });
    expect(set('max-concurrent-runs', '4')).toEqual({ maxConcurrentRuns: 4 });
    expect(set('telegram-bot-token', 'x')).toEqual({ telegramBotToken: 'x' });
  });

  it('resolves the working directory against the CLI folder and home', () => {
    expect(set('default-working-directory', 'vault')).toEqual({
      defaultWorkingDirectory: '/home/owner/notes/vault',
    });
    expect(set('default-working-directory', '~/vault/')).toEqual({
      defaultWorkingDirectory: '/home/owner/vault',
    });
    expect(set('default-working-directory', '/srv/vault')).toEqual({
      defaultWorkingDirectory: '/srv/vault',
    });
  });

  it('refuses a count that is not a whole number', () => {
    for (const value of ['two', '1.5', '-1', '']) {
      expect(() => set('max-concurrent-runs', value)).toThrow(CliError);
      expect(() => set('history-carryover', value)).toThrow(CliError);
    }
  });

  it('clears only what may be cleared', () => {
    expect(findSettingsKey('claude.effort').unset).toEqual({
      providerDefaults: { claude: { effort: null } },
    });
    expect(findSettingsKey('shared-instructions').unset).toEqual({
      sharedInstructions: null,
    });
    expect(findSettingsKey('telegram-bot-token').unset).toEqual({
      telegramBotToken: null,
    });
    expect(findSettingsKey('main-agent').unset).toEqual({ mainAgent: null });
    expect(findSettingsKey('history-retention-days').unset).toEqual({
      historyRetentionDays: null,
    });
    expect(findSettingsKey('default-working-directory').unset).toBe(
      'default-working-directory cannot be unset; set another folder instead',
    );
  });

  it('marks only the token as secret', () => {
    expect(
      SETTINGS_KEYS.filter((key) => key.secret).map((key) => key.name),
    ).toEqual(['telegram-bot-token']);
  });

  it('lists the valid keys for an unknown one', () => {
    expect(() => findSettingsKey('token')).toThrow(
      /^Unknown setting "token"\. Settings: default-provider, claude\.model, /,
    );
  });

  it('names a field the way the owner typed it', () => {
    const key = findSettingsKey('default-provider');

    expect(renameField('defaultProvider: Invalid option', key)).toBe(
      'default-provider: Invalid option',
    );
    expect(renameField('Working directory /x does not exist', key)).toBe(
      'Working directory /x does not exist',
    );
  });
});

describe('formatSettings', () => {
  it('shows every setting without the token', () => {
    expect(formatSettings(view)).toBe(
      [
        'default-provider           claude',
        'claude.model               claude-opus-5-5',
        'claude.effort              (provider default)',
        'codex.model                (provider default)',
        'codex.effort               high',
        'default-working-directory  (not set)',
        'shared-instructions        (none)',
        'main-agent                 (not set: main)',
        'history-carryover          50',
        'history-retention-days     (not set: keep all)',
        'default-permissions        ask',
        'timezone                   Europe/Berlin',
        'max-concurrent-runs        2',
        'telegram-bot-token         not set',
      ].join('\n'),
    );
  });

  it('shows how long history is kept, and says what a change does', () => {
    const key = findSettingsKey('history-retention-days');
    const kept = { ...view, historyRetentionDays: 30 };
    expect(formatSettings(kept)).toContain(
      'history-retention-days     30 days',
    );
    expect(key.show({ ...view, historyRetentionDays: 1 })).toBe('1 day');
    const note = key.note as (view: SettingsView) => string;
    expect(note(kept)).toMatch(/^Messages older than 30 days are deleted/);
    expect(note(view)).toBe('All message history is kept from now on.');
  });

  it('shortens long instructions and says where the token comes from', () => {
    const text = formatSettings({
      ...view,
      sharedInstructions: `${'x'.repeat(80)}\nsecond line\nthird`,
      telegramBotToken: { set: true, source: 'environment' },
    });

    expect(text).toContain(
      `shared-instructions        ${'x'.repeat(59)}… (3 lines)`,
    );
    expect(text).toContain(
      'telegram-bot-token         set (PERO_TELEGRAM_BOT_TOKEN)',
    );
    expect(
      formatSettings({
        ...view,
        telegramBotToken: { set: true, source: 'secrets' },
      }),
    ).toContain('telegram-bot-token         set (secrets)');
    expect(
      formatSettings({
        ...view,
        telegramBotToken: { set: false, source: 'environment' },
      }),
    ).toContain(
      'telegram-bot-token         not valid (PERO_TELEGRAM_BOT_TOKEN)',
    );
  });
});
