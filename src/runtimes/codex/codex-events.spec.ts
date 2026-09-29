import type { ThreadEvent } from '@openai/codex-sdk';
import { describe, expect, it } from 'vitest';
import { RuntimeError, type RuntimeEvent } from '../agent-runtime.js';
import {
  classifyCodexFailure,
  classifyCodexResult,
  newTurnState,
  normalizeCodexEvent,
  type TurnState,
} from './codex-events.js';
import {
  command,
  completed,
  errorItem,
  failed,
  message,
  NOT_GIT_EXIT,
  started,
  THREAD,
  turnStarted,
  UNAUTHORIZED,
} from './testing/codex-events.js';

function play(
  events: ThreadEvent[],
  state: TurnState = newTurnState(),
): RuntimeEvent[] {
  return events.flatMap((event) => normalizeCodexEvent(event, state));
}

const FOLDER = '/home/owner/vault';

describe('normalizeCodexEvent', () => {
  it('reports the thread, each message, and the last message as the result', () => {
    expect(
      play([
        started(),
        turnStarted(),
        message('I will look.', 'item_0'),
        message('Done.', 'item_1'),
        completed(),
      ]),
    ).toEqual([
      { type: 'session', providerSessionId: THREAD },
      { type: 'text', delta: 'I will look.' },
      { type: 'text', delta: 'Done.' },
      { type: 'result', text: 'Done.' },
    ]);
  });

  it('reports the session only once Codex has answered', () => {
    const state = newTurnState();

    expect(play([started(), turnStarted()], state)).toEqual([]);
    expect(play([errorItem('Falling back to HTTPS')], state)).toEqual([]);
    expect(play([message('Hi')], state)).toContainEqual({
      type: 'session',
      providerSessionId: THREAD,
    });
  });

  it('reports no session for a turn refused before Codex answered', () => {
    const state = newTurnState();

    expect(() =>
      play([started(), turnStarted(), failed(UNAUTHORIZED)], state),
    ).toThrow(RuntimeError);
    expect(state.sessionReported).toBe(false);
    expect(state.finished).toBe(true);
  });

  it('reports the resumed thread even without a thread.started event', () => {
    expect(play([message('Hi'), completed()], newTurnState(THREAD))).toEqual([
      { type: 'session', providerSessionId: THREAD },
      { type: 'text', delta: 'Hi' },
      { type: 'result', text: 'Hi' },
    ]);
  });

  it('ignores a warning item, such as a model switch on resume', () => {
    expect(
      play(
        [
          started(),
          errorItem('This session was recorded with model `a`'),
          message('Hi', 'item_1'),
          completed(),
        ],
        newTurnState(THREAD),
      ),
    ).toEqual([
      { type: 'session', providerSessionId: THREAD },
      { type: 'text', delta: 'Hi' },
      { type: 'result', text: 'Hi' },
    ]);
  });

  it('reports each tool once, however often its item is updated', () => {
    const events = play([
      started(),
      command('item_1', 'started'),
      command('item_1', 'completed'),
      {
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'file_change',
          changes: [{ path: `${FOLDER}/a.md`, kind: 'add' }],
          status: 'completed',
        },
      },
      {
        type: 'item.started',
        item: {
          id: 'item_3',
          type: 'mcp_tool_call',
          server: 'notes',
          tool: 'search',
          arguments: {},
          status: 'in_progress',
        },
      },
      {
        type: 'item.started',
        item: { id: 'item_4', type: 'web_search', query: 'pero' },
      },
      {
        type: 'item.completed',
        item: { id: 'item_5', type: 'reasoning', text: 'Thinking' },
      },
    ]);

    expect(events.filter((event) => event.type === 'tool')).toEqual([
      { type: 'tool', name: 'shell' },
      { type: 'tool', name: 'edit' },
      { type: 'tool', name: 'notes/search' },
      { type: 'tool', name: 'web_search' },
    ]);
  });

  it('answers with an empty result when Codex said nothing', () => {
    expect(play([started(), completed()])).toEqual([
      { type: 'session', providerSessionId: THREAD },
      { type: 'result', text: '' },
    ]);
  });

  it('lets retries pass and fails with the message the turn ended with', () => {
    const state = newTurnState();
    play(
      [
        started(),
        { type: 'error', message: 'Reconnecting... 1/5 (stream closed)' },
      ],
      state,
    );

    expect(state.finished).toBe(false);
    expect(() => play([failed('The model is overloaded')], state)).toThrow(
      new RuntimeError('failed', 'The model is overloaded'),
    );
  });
});

describe('classifyCodexResult', () => {
  it('recognizes a signed-out Codex, without the request details', () => {
    const error = classifyCodexResult(UNAUTHORIZED);

    expect(error.kind).toBe('auth');
    expect(error.message).toBe(
      'unexpected status 401 Unauthorized: Missing bearer or basic ' +
        'authentication in header',
    );
  });

  it('recognizes an expired sign-in', () => {
    expect(
      classifyCodexResult(
        'Your access token could not be refreshed. Please log out and sign in again.',
      ).kind,
    ).toBe('auth');
  });

  it('shortens a long failure to its first line', () => {
    const error = classifyCodexResult(`${'x'.repeat(400)}\nsecond line`);

    expect(error.kind).toBe('failed');
    expect(error.message).toHaveLength(300);
    expect(error.message.endsWith('…')).toBe(true);
  });
});

describe('classifyCodexFailure', () => {
  const context = { aborted: false, workingDirectory: FOLDER };

  it('explains that a folder outside Git needs the Agent to skip the check', () => {
    const error = classifyCodexFailure(new Error(NOT_GIT_EXIT), context);

    expect(error.kind).toBe('failed');
    expect(error.message).toContain(FOLDER);
    expect(error.message).toMatch(/Git repository/);
  });

  it("quotes the process's last words rather than its exit code", () => {
    const error = classifyCodexFailure(
      new Error(
        'Codex Exec exited with code 1: Reading prompt from stdin...\n' +
          'Error: the model gpt-0 does not exist\n',
      ),
      context,
    );

    expect(error).toEqual(
      new RuntimeError('failed', 'Error: the model gpt-0 does not exist'),
    );
  });

  it('falls back to the exit code when the process said nothing', () => {
    expect(
      classifyCodexFailure(
        new Error('Codex Exec exited with signal SIGKILL: '),
        context,
      ).message,
    ).toBe('Codex Exec exited with signal SIGKILL');
  });

  it('recognizes a signed-out Codex in the process output', () => {
    expect(
      classifyCodexFailure(
        new Error(
          'Codex Exec exited with code 1: ERROR codex_api: failed to ' +
            'connect: HTTP error: 401 Unauthorized, url: wss://x',
        ),
        context,
      ).kind,
    ).toBe('auth');
  });

  it('recognizes a thread Codex no longer has as lost', () => {
    expect(
      classifyCodexFailure(
        new Error(
          'Codex Exec exited with code 1: Reading prompt from stdin...\n' +
            'Error: thread/resume: thread/resume failed: no rollout found ' +
            'for thread id 0b1c (code -32600)\n',
        ),
        context,
      ),
    ).toEqual(
      new RuntimeError(
        'session_lost',
        'Error: thread/resume: thread/resume failed: no rollout found for thread id 0b1c (code -32600)',
      ),
    );
  });

  it('reports an aborted turn as cancelled, whatever the SDK threw', () => {
    expect(
      classifyCodexFailure(new Error('boom'), { ...context, aborted: true })
        .kind,
    ).toBe('cancelled');
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    expect(classifyCodexFailure(abortError, context).kind).toBe('cancelled');
  });

  it('keeps a failure the turn already classified', () => {
    const failure = new RuntimeError('auth', 'signed out');

    expect(classifyCodexFailure(failure, context)).toBe(failure);
  });

  it('reports a missing Codex binary', () => {
    const error = classifyCodexFailure(
      new Error(
        'Unable to locate Codex CLI binaries. Ensure @openai/codex is installed with optional dependencies.',
      ),
      context,
    );

    expect(error.kind).toBe('failed');
    expect(error.message).toMatch(/Unable to locate Codex/);
  });
});
