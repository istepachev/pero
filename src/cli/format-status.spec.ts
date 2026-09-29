import { describe, expect, it } from 'vitest';
import type { StatusResult } from '../control/protocol.js';
import { formatDuration, formatStatus } from './format-status.js';

const since = '2026-09-28T10:00:00.000Z';

const status: StatusResult = {
  pid: 4242,
  version: '1.2.0',
  dataDir: '/home/owner/.pero',
  startedAt: since,
  uptimeMs: 192_500,
  health: 'degraded',
  components: [
    { name: 'claude', state: 'ok', detail: null, since, required: true },
    {
      name: 'telegram',
      state: 'unconfigured',
      detail: 'Bot token is not set',
      since,
      required: true,
    },
  ],
};

describe('formatStatus', () => {
  it('shows the process and each component', () => {
    expect(formatStatus(status, '1.2.0')).toBe(
      [
        'Pero is running',
        '  PID             4242',
        '  Version         1.2.0',
        '  Data directory  /home/owner/.pero (legacy)',
        '  Uptime          3m 12s',
        '  Health          degraded',
        '',
        'Components',
        '  claude    ok',
        '  telegram  unconfigured  Bot token is not set',
      ].join('\n'),
    );
  });

  it('shows a workspace instead of a data directory', () => {
    const text = formatStatus(
      { ...status, dataDir: '/srv/ws/.pero', workspace: '/srv/ws' },
      '1.2.0',
    );

    expect(text).toContain('  Workspace  /srv/ws\n');
    expect(text).not.toContain('Data directory');
  });

  it('marks a component health does not depend on', () => {
    const text = formatStatus(
      {
        ...status,
        components: [
          {
            name: 'claude',
            state: 'ok',
            detail: 'Signed in',
            since,
            required: true,
          },
          {
            name: 'codex',
            state: 'unconfigured',
            detail: 'Not signed in — run codex login',
            since,
            required: false,
          },
        ],
      },
      '1.2.0',
    );

    expect(text).toContain(
      '  codex   unconfigured  Not signed in — run codex login (not in use)',
    );
    expect(text).toContain('  claude  ok            Signed in\n');
  });

  it('suggests a restart when the installed version differs', () => {
    expect(formatStatus(status, '1.3.0')).toContain(
      'The installed version is 1.3.0; restart Pero to use it (pero stop, then pero run).',
    );
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [59_999, '59s'],
    [60_000, '1m 0s'],
    [3_600_000 + 5 * 60_000 + 7_000, '1h 5m'],
    [3 * 86_400_000 + 4 * 3_600_000, '3d 4h'],
  ])('formats %i ms as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
