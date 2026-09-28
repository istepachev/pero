import type { ThreadEvent } from '@openai/codex-sdk';

/* Codex SDK events for tests, shaped like those `codex exec` emits. */

export const THREAD = '01a0e889-b6a9-7a63-abd2-cca544a0846d';

/** The first event of a turn, naming the thread. */
export function started(threadId = THREAD): ThreadEvent {
  return { type: 'thread.started', thread_id: threadId };
}

export function turnStarted(): ThreadEvent {
  return { type: 'turn.started' };
}

/** A message of the reply. */
export function message(text: string, id = 'item_0'): ThreadEvent {
  return {
    type: 'item.completed',
    item: { id, type: 'agent_message', text },
  };
}

/** A shell command, as it starts or once it has run. */
export function command(
  id: string,
  phase: 'started' | 'completed' = 'completed',
): ThreadEvent {
  return {
    type: phase === 'started' ? 'item.started' : 'item.completed',
    item: {
      id,
      type: 'command_execution',
      command: '/bin/bash -lc ls',
      aggregated_output: '',
      status: phase === 'started' ? 'in_progress' : 'completed',
    },
  };
}

/** A non-fatal error Codex reports as an item, such as a warning. */
export function errorItem(text: string, id = 'item_0'): ThreadEvent {
  return { type: 'item.completed', item: { id, type: 'error', message: text } };
}

export function completed(): ThreadEvent {
  return {
    type: 'turn.completed',
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
  };
}

export function failed(text: string): ThreadEvent {
  return { type: 'turn.failed', error: { message: text } };
}

/** What Codex answers when it is not signed in. */
export const UNAUTHORIZED =
  'unexpected status 401 Unauthorized: Missing bearer or basic ' +
  'authentication in header, url: https://api.openai.com/v1/responses, ' +
  'cf-ray: a4239fc54c0b7dae-IAD, request id: req_f3bd';

/** How the SDK reports Codex refusing a folder outside Git. */
export const NOT_GIT_EXIT =
  'Codex Exec exited with code 1: Reading prompt from stdin...\n' +
  'Not inside a trusted directory and --skip-git-repo-check was not ' +
  'specified.\n';
