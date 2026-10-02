import { describe, expect, it } from 'vitest';
import { MAX_BUTTON_ID_BYTES } from '../channel-adapter.js';
import { buttonCommand, COMMANDS, isCommand } from './command-list.js';
import {
  type AgentStatus,
  context,
  helpScreen,
  newConfirmScreen,
  type Screen,
  statusScreen,
  stopScreen,
} from './screens.js';

const NOW = new Date('2026-10-01T12:00:00Z');

function agentStatus(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    agent: {
      name: 'coach',
      file: 'data/System/Agents/Coach.md',
      provider: 'codex',
      model: 'gpt-5.5',
      effort: null,
      permissions: 'ask',
      origins: {
        provider: 'note',
        model: 'pero',
        effort: 'default',
        permissions: 'note',
        workingDirectory: 'note',
      },
      errors: [],
    },
    folder: 'projects/training',
    folderProblem: null,
    runningSince: null,
    queued: 0,
    lastAnswerAt: null,
    session: null,
    startedOver: false,
    ...overrides,
  };
}

function status(agent: AgentStatus | null, unanswered: string | null = null) {
  return statusScreen({
    where: 'Running',
    agent,
    unanswered,
    components: [
      {
        name: 'telegram',
        state: 'ok',
        detail: null,
        since: NOW.toISOString(),
        required: true,
      },
    ],
    timezone: 'Europe/Berlin',
    now: NOW,
  });
}

function buttonIds(screen: Screen): string[] {
  return (screen.buttons ?? []).flat().map((button) => button.id);
}

describe('screens', () => {
  it('shows a Codex Agent without a context window', () => {
    const screen = status(
      agentStatus({
        runningSince: new Date(NOW.getTime() - 130_000),
        queued: 1,
        session: {
          id: 12,
          createdAt: new Date('2026-10-01T07:14:00Z'),
          turns: 1,
          contextTokens: 84_400,
          contextWindow: null,
        },
      }),
    );

    expect(screen.text).toBe(
      [
        'Agent coach · Running',
        'State: answering for 2m 10s · 1 queued',
        'Config: data/System/Agents/Coach.md',
        'Provider: codex · model gpt-5.5 (Pero.md) · default effort',
        'Permissions: ask',
        'Folder: projects/training',
        'Session: #12 since 2026-10-01 09:14 · 1 turn',
        'Context: ~84k tokens',
        '',
        'Pero: telegram ok',
      ].join('\n'),
    );
    expect(buttonIds(screen)).toEqual([
      '/stop',
      '/new ask',
      '/status',
      '/model',
      '/effort',
    ]);
  });

  it("leaves out the context before a first turn, and shows the note's errors and folder problem", () => {
    const screen = status(
      agentStatus({
        agent: {
          ...agentStatus().agent,
          errors: [{ property: 'effort', message: 'must be one of low, high' }],
        },
        folderProblem: 'projects/training does not exist',
      }),
    );

    expect(screen.text).not.toContain('Context:');
    expect(screen.text).toContain(
      '\nSession: none yet: the next message starts one\n' +
        'Note errors, so its last good version is in use:\n' +
        '  effort: must be one of low, high\n' +
        'Warning: projects/training does not exist\n',
    );
  });

  it('shows why no one answers, with only a way to look again', () => {
    const screen = status(
      null,
      'Agent coach is disabled, so no one answers here.',
    );

    expect(screen.text).toBe(
      'Agent coach is disabled, so no one answers here.\n\nPero: telegram ok',
    );
    expect(buttonIds(screen)).toEqual(['/status']);
  });

  it('measures context in thousands, or millions, of tokens', () => {
    expect(context(84_400, 200_000)).toBe('~84k of 200k tokens (42%)');
    expect(context(612, 1_000_000)).toBe('~612 of 1M tokens (0%)');
    expect(context(1_250_000, null)).toBe('~1.3M tokens');
  });

  it('says what /stop ended', () => {
    expect(stopScreen('main', { stopped: false, dropped: 2 }, null).text).toBe(
      "Agent main hadn't started answering. 2 waiting messages won't be answered.",
    );
    expect(stopScreen(null, { stopped: false, dropped: 0 }, '@ada')).toEqual({
      text: "The Agent isn't answering anything here.\n— @ada",
      buttons: [[{ id: '/status', label: '« Back' }]],
    });
  });

  it('gives every button a command Pero answers, within the ID limit', () => {
    for (const screen of [
      helpScreen(),
      status(agentStatus({ queued: 1 })),
      newConfirmScreen('main'),
    ]) {
      for (const id of buttonIds(screen)) {
        expect(Buffer.byteLength(id)).toBeLessThanOrEqual(MAX_BUTTON_ID_BYTES);
        expect(isCommand(buttonCommand(id)!.name)).toBe(true);
      }
    }
  });
});

describe('command-list', () => {
  it('names every command as Telegram allows', () => {
    for (const { name, description } of COMMANDS) {
      expect(name).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(description.length).toBeLessThanOrEqual(256);
    }
  });

  it("reads a button's command, and nothing from a tool request's button", () => {
    expect(buttonCommand('/new yes')).toEqual({ name: 'new', args: 'yes' });
    expect(buttonCommand('/Status')).toEqual({ name: 'status', args: '' });
    expect(buttonCommand('aB3-xY_z:allow')).toBeNull();
  });
});
