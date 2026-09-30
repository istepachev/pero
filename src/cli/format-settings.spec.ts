import { describe, expect, it } from 'vitest';
import type { SettingsView } from '../control/protocol.js';
import { formatSettings, formatToken } from './format-settings.js';
import { preview } from './preview.js';

const workspace: SettingsView = {
  defaultProvider: 'claude',
  providerDefaults: {
    claude: { model: 'opus', effort: null },
    codex: { model: null, effort: null },
  },
  defaultWorkingDirectory: '/home/me/workspace/data',
  sharedInstructions: 'Be calm and brief.\nReply in my language.',
  mainAgent: 'main',
  historyCarryover: 50,
  historyRetentionDays: 90,
  defaultPermissions: 'ask',
  timezone: 'Europe/Berlin',
  maxConcurrentRuns: 2,
  telegramBotToken: { set: true, source: 'env-file' },
  files: { pero: 'data/Settings/Pero.md', config: '.pero/config.yaml' },
  newTopics: 'create-agent',
  setInPero: ['claude-model', 'history-retention-days', 'timezone'],
};

describe('formatSettings in a workspace', () => {
  it("shows Pero.md, marking Pero's own defaults, then config.yaml and the token", () => {
    expect(formatSettings(workspace, '/home/me/workspace/.pero')).toBe(
      [
        'data/Settings/Pero.md',
        '  provider                claude (default)',
        '  claude-model            opus',
        '  claude-effort           (provider default)',
        '  codex-model             (provider default)',
        '  codex-effort            (provider default)',
        '  permissions             ask (default)',
        '  timezone                Europe/Berlin',
        '  main-agent              main (default)',
        '  new-topics              create-agent (default)',
        '  history-carryover       50 (default)',
        '  history-retention-days  90',
        '  max-concurrent-runs     2 (default)',
        '  (body)                  Be calm and brief. (2 lines)',
        '.pero/config.yaml',
        '  data                    /home/me/workspace/data',
        'Telegram bot token: set (.env)',
      ].join('\n'),
    );
  });
});

describe('formatSettings in a legacy data directory', () => {
  it('says it needs a workspace, and shows only the token', () => {
    expect(
      formatSettings(
        {
          ...workspace,
          files: null,
          newTopics: null,
          setInPero: null,
          telegramBotToken: { set: true, source: 'secrets' },
        },
        '/home/me/.pero',
      ),
    ).toBe(
      [
        '/home/me/.pero is a legacy data directory, which has no Agents any more. Make a workspace with pero init <folder>, whose notes define them.',
        'Telegram bot token: set (secrets)',
      ].join('\n'),
    );
  });
});

describe('formatToken', () => {
  const token = (telegramBotToken: SettingsView['telegramBotToken']) =>
    formatToken({ ...workspace, telegramBotToken });

  it('says where the token comes from, never what it is', () => {
    expect(token({ set: true, source: 'environment' })).toBe(
      'set (PERO_TELEGRAM_BOT_TOKEN)',
    );
    expect(token({ set: true, source: 'env-file' })).toBe('set (.env)');
    expect(token({ set: false, source: 'environment' })).toBe(
      'not valid (PERO_TELEGRAM_BOT_TOKEN)',
    );
    expect(token({ set: false, source: null })).toBe('not set');
  });
});

describe('preview', () => {
  it('shortens long text to its first line, counting the lines', () => {
    expect(preview(null)).toBe('(none)');
    expect(preview('Be brief.')).toBe('Be brief.');
    expect(preview(`${'x'.repeat(80)}\nsecond line\nthird`)).toBe(
      `${'x'.repeat(59)}… (3 lines)`,
    );
  });
});
