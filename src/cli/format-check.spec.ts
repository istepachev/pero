import { describe, expect, it } from 'vitest';
import type { WorkspaceCheck } from '../system-files/check.js';
import { formatCheck } from './format-check.js';

const CLEAN: WorkspaceCheck = {
  systemFolder: 'data/System',
  agents: 2,
  workflows: 1,
  topicsChecked: false,
  problems: [],
};

describe('formatCheck', () => {
  it('says what it checked when there are no problems', () => {
    expect(formatCheck(CLEAN)).toBe(
      [
        'Checked 2 Agents and 1 Workflow in data/System: no problems.',
        "Topic titles weren't checked against Telegram's topics, since Pero isn't running.",
      ].join('\n'),
    );
  });

  it('leaves out the topic note once topics were checked', () => {
    expect(
      formatCheck({ ...CLEAN, agents: 1, workflows: 0, topicsChecked: true }),
    ).toBe('Checked 1 Agent and 0 Workflows in data/System: no problems.');
  });

  it('groups problems under their file', () => {
    expect(
      formatCheck({
        ...CLEAN,
        problems: [
          {
            file: 'data/System/Workflows/Weekly health report.md',
            property: 'channel',
            message: 'no topic titled "Helth"; seen topics: General, Health',
          },
          {
            file: 'data/System/Agents/Coach.md',
            property: 'modle',
            message: 'unknown property (did you mean model?)',
          },
          {
            file: 'data/System/Agents/Coach.md',
            property: null,
            message: 'line 4: Map keys must be unique',
          },
        ],
      }),
    ).toBe(
      [
        'data/System/Workflows/Weekly health report.md',
        '  channel: no topic titled "Helth"; seen topics: General, Health',
        'data/System/Agents/Coach.md',
        '  modle: unknown property (did you mean model?)',
        '  line 4: Map keys must be unique',
        '',
        '3 problems in 2 files.',
        "Topic titles weren't checked against Telegram's topics, since Pero isn't running.",
      ].join('\n'),
    );
  });

  it('says nothing about topics when config.yaml kept the notes unchecked', () => {
    expect(
      formatCheck({
        ...CLEAN,
        systemFolder: null,
        problems: [
          {
            file: '.pero/config.yaml',
            property: null,
            message: 'line 2: bogus: unknown key',
          },
        ],
      }),
    ).toBe(
      [
        '.pero/config.yaml',
        '  line 2: bogus: unknown key',
        '',
        '1 problem in 1 file.',
      ].join('\n'),
    );
  });
});
