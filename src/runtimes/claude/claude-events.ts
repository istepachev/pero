import {
  AbortError,
  type SDKAssistantMessageError,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { RuntimeError, type RuntimeEvent } from '../agent-runtime.js';

/*
 * Translates the Claude Agent SDK's messages into Pero's runtime events and
 * its failures into `RuntimeError`s. Pure, so tests can feed it scripted
 * messages; SDK objects never leave this folder.
 */

/** What one turn has seen so far; start each turn with `newTurnState()`. */
export interface TurnState {
  /** The conversation's ID, once Claude Code has named it. */
  sessionId: string | null;
  sessionReported: boolean;
  /** The API error an assistant message reported, if any. */
  assistantError: SDKAssistantMessageError | null;
  /** Set once the turn's result has arrived. */
  finished: boolean;
}

export function newTurnState(): TurnState {
  return {
    sessionId: null,
    sessionReported: false,
    assistantError: null,
    finished: false,
  };
}

/** How long a failure message for the owner may be. */
const MAX_MESSAGE_LENGTH = 300;

/** Text that means Claude Code is not signed in, or its sign-in expired. */
const SIGNED_OUT =
  /\/login\b|not logged in|invalid api key|authentication_error|oauth token (?:has )?(?:expired|been revoked)/i;

/**
 * What Claude Code says when it has no conversation to resume by that ID,
 * as in `No conversation found with session ID: <id>` (Claude Code 2.1).
 */
const SESSION_LOST = /no conversation found with session id/i;

/** API errors that a new sign-in fixes. */
const AUTH_ERRORS: ReadonlySet<SDKAssistantMessageError> = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
]);

/**
 * The events `message` means for the turn. Throws a `RuntimeError` when it
 * ends the turn with a failure.
 *
 * The session is reported only once Claude has answered: Claude Code keeps
 * no conversation for a turn that failed before that, such as one signed
 * out, and resuming its ID would fail every later turn.
 */
export function normalizeClaudeMessage(
  message: SDKMessage,
  state: TurnState,
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  if ('session_id' in message && message.session_id) {
    state.sessionId ??= message.session_id;
  }
  const answered =
    (message.type === 'assistant' && message.error === undefined) ||
    (message.type === 'result' &&
      message.subtype === 'success' &&
      !message.is_error);
  if (answered && !state.sessionReported && state.sessionId !== null) {
    state.sessionReported = true;
    events.push({ type: 'session', providerSessionId: state.sessionId });
  }

  switch (message.type) {
    case 'assistant':
      if (message.error !== undefined) {
        // Its text is the error, which the result repeats.
        state.assistantError = message.error;
        break;
      }
      // A subagent's steps are not the reply.
      if (message.parent_tool_use_id !== null) break;
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text !== '') {
          events.push({ type: 'text', delta: block.text });
        } else if (block.type === 'tool_use') {
          events.push({ type: 'tool', name: block.name });
        }
      }
      break;
    case 'result':
      state.finished = true;
      if (message.subtype === 'success' && !message.is_error) {
        events.push({ type: 'result', text: message.result });
        break;
      }
      throw classifyClaudeResult(
        message.subtype === 'success'
          ? message.result
          : message.errors.join('; ') || describeSubtype(message.subtype),
        state.assistantError,
      );
  }
  return events;
}

/** A failed result: its text, and the API error reported before it. */
export function classifyClaudeResult(
  text: string,
  assistantError: SDKAssistantMessageError | null,
): RuntimeError {
  const auth =
    (assistantError !== null && AUTH_ERRORS.has(assistantError)) ||
    SIGNED_OUT.test(text);
  return new RuntimeError(
    auth ? 'auth' : SESSION_LOST.test(text) ? 'session_lost' : 'failed',
    oneLine(text) || `Claude failed (${assistantError ?? 'unknown error'})`,
  );
}

/**
 * An error the SDK threw, such as Claude Code exiting early, as a
 * `RuntimeError`. `stderr` is the process's last output, which may say why.
 */
export function classifyClaudeFailure(
  error: unknown,
  { aborted, stderr }: { aborted: boolean; stderr: string },
): RuntimeError {
  if (error instanceof RuntimeError && !aborted) return error;
  if (aborted || error instanceof AbortError) {
    return new RuntimeError('cancelled', 'The turn was aborted');
  }
  const message = error instanceof Error ? error.message : String(error);
  const auth = SIGNED_OUT.test(message) || SIGNED_OUT.test(stderr);
  const lost = SESSION_LOST.test(message) || SESSION_LOST.test(stderr);
  // An exit code alone says little; the process's last words say more.
  const reason = /process exited with code/.test(message)
    ? lastLine(stderr) || oneLine(message)
    : oneLine(message) || lastLine(stderr);
  return new RuntimeError(
    auth ? 'auth' : lost ? 'session_lost' : 'failed',
    reason || 'Claude Code failed',
  );
}

function describeSubtype(subtype: string): string {
  switch (subtype) {
    case 'error_max_turns':
      return 'Claude stopped after too many steps';
    case 'error_during_execution':
      return 'Claude Code failed during the turn';
    default:
      return `Claude stopped early (${subtype})`;
  }
}

/** The first line of `text` with content, shortened for a chat message. */
function oneLine(text: string): string {
  return shorten(lines(text)[0] ?? '');
}

/** The last line of `text` with content, shortened for a chat message. */
function lastLine(text: string): string {
  return shorten(lines(text).at(-1) ?? '');
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function shorten(line: string): string {
  return line.length > MAX_MESSAGE_LENGTH
    ? `${line.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : line;
}
