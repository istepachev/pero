import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import { RuntimeError, type RuntimeEvent } from '../agent-runtime.js';

/*
 * Translates the Codex SDK's events into Pero's runtime events and its
 * failures into `RuntimeError`s. Pure, so tests can feed it scripted
 * events; SDK objects never leave this folder.
 */

/** What one turn has seen so far; start each turn with `newTurnState()`. */
export interface TurnState {
  /** The thread's ID, once Codex has named it or the turn resumes one. */
  threadId: string | null;
  sessionReported: boolean;
  /** The latest message of the reply, which the result repeats. */
  lastMessage: string | null;
  /** Items already reported as tools, by item ID. */
  seenItems: Set<string>;
  /** Set once the turn has completed or failed. */
  finished: boolean;
}

/** A fresh state; `resumed` is the thread the turn resumes, if any. */
export function newTurnState(resumed?: string): TurnState {
  return {
    threadId: resumed ?? null,
    sessionReported: false,
    lastMessage: null,
    seenItems: new Set(),
    finished: false,
  };
}

/** How long a failure message for the owner may be. */
const MAX_MESSAGE_LENGTH = 300;

/** Text that means Codex is not signed in, or its sign-in expired. */
const SIGNED_OUT =
  /\b401 unauthorized\b|not logged in|codex login|access token could not be refreshed|log out and sign in again/i;

/**
 * What Codex says when it has no thread to resume by that ID, as in
 * `thread/resume failed: no rollout found for thread id <id>` (Codex 0.158).
 */
const SESSION_LOST = /no rollout found for thread id/i;

/** What Codex says when its folder is not a Git repository. */
const NOT_GIT = /not inside a trusted directory/i;

/** How the SDK reports that the Codex process failed. */
const EXEC_EXITED = /^Codex Exec exited with [^:]*:\s*/;

/** Codex's own progress lines, which never explain a failure. */
const NOISE = /^Reading prompt from stdin|^WARNING: proceeding/;

/**
 * The events `event` means for the turn. Throws a `RuntimeError` when it
 * ends the turn with a failure.
 *
 * The session is reported only once Codex has answered, so a turn refused
 * before that, such as one signed out, leaves no thread for later turns
 * to resume.
 */
export function normalizeCodexEvent(
  event: ThreadEvent,
  state: TurnState,
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  if (event.type === 'thread.started') state.threadId = event.thread_id;
  const answered =
    (event.type === 'item.completed' && event.item.type !== 'error') ||
    event.type === 'turn.completed';
  if (answered && !state.sessionReported && state.threadId !== null) {
    state.sessionReported = true;
    events.push({ type: 'session', providerSessionId: state.threadId });
  }

  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const tool = toolName(event.item);
      if (tool !== null && !state.seenItems.has(event.item.id)) {
        state.seenItems.add(event.item.id);
        events.push({ type: 'tool', name: tool });
      }
      if (
        event.type === 'item.completed' &&
        event.item.type === 'agent_message' &&
        event.item.text !== ''
      ) {
        state.lastMessage = event.item.text;
        events.push({ type: 'text', delta: event.item.text });
      }
      break;
    }
    case 'turn.completed':
      state.finished = true;
      events.push({ type: 'result', text: state.lastMessage ?? '' });
      break;
    case 'turn.failed':
      state.finished = true;
      throw classifyCodexResult(event.error.message);
    // `error` events report retries; the turn goes on until it fails.
  }
  return events;
}

/** The tool `item` stands for; null when it is not one. */
function toolName(item: ThreadItem): string | null {
  switch (item.type) {
    case 'command_execution':
      return 'shell';
    case 'file_change':
      return 'edit';
    case 'mcp_tool_call':
      return `${item.server}/${item.tool}`;
    case 'web_search':
      return 'web_search';
    default:
      return null;
  }
}

/** A failed turn, from the message Codex ended it with. */
export function classifyCodexResult(message: string): RuntimeError {
  return new RuntimeError(kindOf(message), oneLine(message) || 'Codex failed');
}

/**
 * An error the SDK threw, such as the Codex process exiting early, as a
 * `RuntimeError`. `workingDirectory` names the folder in a Git refusal.
 */
export function classifyCodexFailure(
  error: unknown,
  { aborted, workingDirectory }: { aborted: boolean; workingDirectory: string },
): RuntimeError {
  if (error instanceof RuntimeError && !aborted) return error;
  if (aborted || (error instanceof Error && error.name === 'AbortError')) {
    return new RuntimeError('cancelled', 'The turn was aborted');
  }
  const message = error instanceof Error ? error.message : String(error);
  if (NOT_GIT.test(message)) {
    return new RuntimeError(
      'failed',
      `Codex works only in a Git repository, and ${workingDirectory} is ` +
        `not one; run git init there, or set skip-git-repo-check: true in the Channel's note`,
    );
  }
  // The process's last words say more than its exit code.
  const reason = EXEC_EXITED.test(message)
    ? lastLine(message.replace(EXEC_EXITED, '')) ||
      oneLine(message.replace(/:\s*$/, ''))
    : oneLine(message);
  return new RuntimeError(kindOf(message), reason || 'Codex failed');
}

/** The kind of failure Codex's `message` reports. */
function kindOf(message: string): RuntimeError['kind'] {
  if (SIGNED_OUT.test(message)) return 'auth';
  return SESSION_LOST.test(message) ? 'session_lost' : 'failed';
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
    .filter((part) => part !== '' && !NOISE.test(part));
}

/** `line` without request details, short enough for a chat message. */
function shorten(line: string): string {
  // Codex appends the URL and request IDs, which mean nothing in a chat.
  const short = line.replace(/,\s*url:.*$/, '');
  return short.length > MAX_MESSAGE_LENGTH
    ? `${short.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : short;
}
