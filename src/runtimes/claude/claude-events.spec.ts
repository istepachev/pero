import { AbortError, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { RuntimeError, type RuntimeEvent } from '../agent-runtime.js';
import {
  classifyClaudeFailure,
  newTurnState,
  normalizeClaudeMessage,
} from './claude-events.js';
import {
  assistant,
  assistantError,
  failedResult,
  init,
  SESSION,
  success,
} from './testing/claude-messages.js';

/** The events for `messages` in order, or the error they end with. */
function run(messages: SDKMessage[]): {
  events: RuntimeEvent[];
  error?: RuntimeError;
} {
  const state = newTurnState();
  const events: RuntimeEvent[] = [];
  try {
    for (const message of messages) {
      events.push(...normalizeClaudeMessage(message, state));
    }
  } catch (error) {
    return { events, error: error as RuntimeError };
  }
  return { events };
}

describe('normalizeClaudeMessage', () => {
  it('reports the session once Claude answers, then text, tools, and the result', () => {
    expect(
      run([
        init(),
        assistant([
          { type: 'thinking', thinking: 'Hmm', signature: 'sig' },
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        ]),
        assistant([{ type: 'text', text: 'Done.' }]),
        success('Let me look.\n\nDone.'),
      ]).events,
    ).toEqual([
      { type: 'session', providerSessionId: SESSION },
      { type: 'text', delta: 'Let me look.' },
      { type: 'tool', name: 'Read' },
      { type: 'text', delta: 'Done.' },
      { type: 'result', text: 'Let me look.\n\nDone.' },
    ]);
  });

  it('reports the session at the result when no assistant message came first', () => {
    expect(run([init(), success('Hi')]).events).toEqual([
      { type: 'session', providerSessionId: SESSION },
      { type: 'result', text: 'Hi' },
    ]);
  });

  it("reports a resumed session's ID", () => {
    const resumed = 'b2a0e3c4-0000-4000-8000-000000000002';
    expect(
      run([init(resumed), assistant([{ type: 'text', text: 'Hi' }])]).events[0],
    ).toEqual({ type: 'session', providerSessionId: resumed });
  });

  it("leaves out a subagent's steps, which still show the session is kept", () => {
    expect(
      run([
        init(),
        assistant([{ type: 'text', text: 'Searching.' }], 'tool-1'),
        assistant(
          [{ type: 'tool_use', id: 't2', name: 'Grep', input: {} }],
          'tool-1',
        ),
      ]).events,
    ).toEqual([{ type: 'session', providerSessionId: SESSION }]);
  });

  it('ignores messages that are neither replies nor results', () => {
    expect(
      run([
        init(),
        { type: 'system', subtype: 'status', status: null } as SDKMessage,
        { type: 'user', session_id: SESSION } as SDKMessage,
      ]).events,
    ).toEqual([]);
  });

  describe('failures', () => {
    it('reports no session when signed out, since Claude Code keeps none', () => {
      const { events, error } = run([
        init(),
        assistantError(
          'authentication_failed',
          'Not logged in · Please run /login',
        ),
        success('Not logged in · Please run /login', true),
      ]);

      expect(events).toEqual([]);
      expect(error).toBeInstanceOf(RuntimeError);
      expect(error).toMatchObject({
        kind: 'auth',
        message: 'Not logged in · Please run /login',
      });
    });

    it('recognizes an expired sign-in from its text alone', () => {
      expect(
        run([
          init(),
          success('OAuth token has expired. Please run /login', true),
        ]).error,
      ).toMatchObject({ kind: 'auth' });
    });

    it('reports other API errors as failed, keeping the session once answered', () => {
      const { events, error } = run([
        init(),
        assistant([{ type: 'text', text: 'Working on it.' }]),
        assistantError('rate_limit', 'API Error: Rate limit reached'),
        success('API Error: Rate limit reached', true),
      ]);

      expect(events).toEqual([
        { type: 'session', providerSessionId: SESSION },
        { type: 'text', delta: 'Working on it.' },
      ]);
      expect(error).toMatchObject({
        kind: 'failed',
        message: 'API Error: Rate limit reached',
      });
    });

    it.each([
      ['error_max_turns', [], 'Claude stopped after too many steps'],
      ['error_during_execution', [], 'Claude Code failed during the turn'],
      [
        'error_during_execution',
        ['No conversation found with session ID: x'],
        'No conversation found with session ID: x',
      ],
    ] as const)('reports a %s result as failed', (subtype, errors, message) => {
      expect(
        run([init(), failedResult(subtype, [...errors])]).error,
      ).toMatchObject({
        kind: 'failed',
        message,
      });
    });

    it('keeps only the first line of a long failure', () => {
      const { error } = run([
        init(),
        success(`${'x'.repeat(400)}\nat Stack.frame (file.js:1)`, true),
      ]);
      expect(error!.message).toHaveLength(300);
      expect(error!.message.endsWith('…')).toBe(true);
    });
  });
});

describe('classifyClaudeFailure', () => {
  const none = { aborted: false, stderr: '' };

  it('reports an abort as cancelled', () => {
    expect(
      classifyClaudeFailure(new AbortError('aborted'), none),
    ).toMatchObject({
      kind: 'cancelled',
    });
    expect(
      classifyClaudeFailure(new Error('write EPIPE'), {
        aborted: true,
        stderr: '',
      }),
    ).toMatchObject({ kind: 'cancelled' });
    expect(
      classifyClaudeFailure(new RuntimeError('failed', 'Rate limited'), {
        aborted: true,
        stderr: '',
      }),
    ).toMatchObject({ kind: 'cancelled' });
  });

  it('keeps a RuntimeError the turn already classified', () => {
    const error = new RuntimeError('auth', 'Not logged in');
    expect(classifyClaudeFailure(error, none)).toBe(error);
  });

  it("explains an early exit with Claude Code's last words", () => {
    expect(
      classifyClaudeFailure(
        new Error('Claude Code process exited with code 1'),
        { aborted: false, stderr: 'Loading settings\nInvalid model: opus-9\n' },
      ),
    ).toMatchObject({ kind: 'failed', message: 'Invalid model: opus-9' });
  });

  it('recognizes a sign-in failure in the output', () => {
    expect(
      classifyClaudeFailure(
        new Error('Claude Code process exited with code 1'),
        { aborted: false, stderr: 'Invalid API key · Please run /login' },
      ),
    ).toMatchObject({ kind: 'auth' });
  });

  it('reports anything else as failed', () => {
    expect(
      classifyClaudeFailure(new Error('spawn claude ENOENT'), none),
    ).toMatchObject({ kind: 'failed', message: 'spawn claude ENOENT' });
    expect(classifyClaudeFailure('boom', none)).toMatchObject({
      kind: 'failed',
      message: 'boom',
    });
  });
});
