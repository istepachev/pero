import type {
  SDKAssistantMessageError,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';

/*
 * Claude Agent SDK messages for tests, with only the fields Pero reads. The
 * SDK's own types carry many more, so each is cast.
 */

export const SESSION = '5f593651-a5ce-4541-92e0-457cbf598141';

/** Claude Code's first message of a turn, naming the conversation. */
export function init(sessionId = SESSION): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
  } as unknown as SDKMessage;
}

/** An assistant message; `parent` marks a subagent's. */
export function assistant(
  content: unknown[],
  parent: string | null = null,
): SDKMessage {
  return {
    type: 'assistant',
    message: { role: 'assistant', content },
    parent_tool_use_id: parent,
    session_id: SESSION,
  } as unknown as SDKMessage;
}

/** The message Claude Code sends in place of a reply when the API fails. */
export function assistantError(
  error: SDKAssistantMessageError,
  text: string,
): SDKMessage {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    error,
    session_id: SESSION,
  } as unknown as SDKMessage;
}

/** A finished turn; `isError` when it ended on an API error. */
export function success(result: string, isError = false): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: isError,
    result,
    session_id: SESSION,
  } as unknown as SDKMessage;
}

/** A turn that stopped early. */
export function failedResult(subtype: string, errors: string[]): SDKMessage {
  return {
    type: 'result',
    subtype,
    is_error: true,
    errors,
    session_id: SESSION,
  } as unknown as SDKMessage;
}
