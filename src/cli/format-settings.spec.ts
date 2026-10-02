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
  dataFolder: '/home/me/workspace/data',
  historyCarryover: 50,
  historyRetentionDays: 90,
  defaultPermissions: 'ask',
  timezone: 'Europe/Berlin',
  maxConcurrentRuns: 2,
  telegramBotToken: { set: true, source: 'env-file' },
  files: { pero: 'data/System/Pero.md', config: '.pero/config.yaml' },
  setInPero: ['claude-model', 'history-retention-days', 'timezone'],
};

describe('formatSettings', () => {
  it("shows Pero.md, marking Pero's own defaults, then config.yaml and the token", () => {
    expect(formatSettings(workspace)).toBe(
      [
        'data/System/Pero.md',
        '  provider                claude (default)',
        '  claude-model            opus',
        '  claude-effort           (provider default)',
        '  codex-model             (provider default)',
        '  codex-effort            (provider default)',
        '  permissions             ask (default)',
        '  timezone                Europe/Berlin',
        '  history-carryover       50 (default)',
        '  history-retention-days  90',
        '  max-concurrent-runs     2 (default)',
        '.pero/config.yaml',
        '  data                    /home/me/workspace/data',
        'Telegram bot token: set (.env)',
      ].join('\n'),
    );
  });
});

describe('formatToken', () => {
  it('says where the token comes from, never what it is', () => {
    expect(formatToken({ set: true, source: 'environment' })).toBe(
      'set (PERO_TELEGRAM_BOT_TOKEN)',
    );
    expect(formatToken({ set: true, source: 'env-file' })).toBe('set (.env)');
    expect(formatToken({ set: false, source: 'environment' })).toBe(
      'not valid (PERO_TELEGRAM_BOT_TOKEN)',
    );
    expect(formatToken({ set: false, source: null })).toBe('not set');
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
