import type { Provider, ProviderOptions } from '../config/provider-options.js';
import type { ToolPolicy } from '../config/tool-policy.js';

export type { ToolPolicy };

/*
 * The contract between AgentManager and a provider SDK. Only adapters that
 * implement it import an agent SDK; the rest of Pero sees these shapes.
 * Provider session IDs are opaque strings.
 */

/** A tool the Agent wants to use that its permissions don't cover. */
export interface ToolApprovalRequest {
  /** The provider's name for the tool, such as `Bash`. */
  tool: string;
  /** One line saying what the tool would do, for the owner to judge. */
  summary: string;
  /** Aborts when the turn no longer needs the answer. */
  signal: AbortSignal;
}

/** The owner's answer; a denial's reason goes back to the Agent. */
export type ToolApproval = { allow: true } | { allow: false; reason: string };

/** Asks the owner whether the Agent may use a tool. */
export type ToolApprover = (
  request: ToolApprovalRequest,
) => Promise<ToolApproval>;

/** One turn of an Agent, with its settings already resolved. */
export interface RuntimeRequest {
  agentId: number;
  input: string;
  /** The shared instructions, unless the Agent opts out, then its own. */
  instructions: string;
  /** Model and effort; the adapter omits each null one. */
  providerOptions: ProviderOptions;
  /** The effective folder; the adapter passes it to the SDK explicitly. */
  workingDirectory: string;
  /** The conversation to resume; absent to start a new one. */
  providerSessionId?: string;
  /** Tools the Agent may use; the adapter maps it to its provider's controls. */
  toolPolicy: ToolPolicy;
  /**
   * Answers for tools the policy leaves to the owner; absent when no one
   * can answer, so the adapter denies them.
   */
  approve?: ToolApprover;
  /** Aborts the turn; the adapter then stops promptly. */
  signal: AbortSignal;
}

/** What a turn reports as it runs, normalized across providers. */
export type RuntimeEvent =
  /** The provider's ID for the conversation, whether created or resumed. */
  | { type: 'session'; providerSessionId: string }
  /** Part of the reply as it streams. */
  | { type: 'text'; delta: string }
  /** The Agent used a tool. */
  | { type: 'tool'; name: string }
  /** The whole reply once the turn has finished. */
  | { type: 'result'; text: string };

/**
 * Why a turn failed: signed out of the provider, aborted through its
 * signal, or anything else.
 */
export type RuntimeErrorKind = 'auth' | 'cancelled' | 'failed';

/** A failed turn; adapters turn their SDK's errors into this. */
export class RuntimeError extends Error {
  override name = 'RuntimeError';

  constructor(
    readonly kind: RuntimeErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** Executes Agents on one provider. */
export interface AgentRuntime {
  readonly kind: Provider;
  /**
   * Runs one turn. The events end with the turn; a failure throws a
   * `RuntimeError`.
   */
  execute(request: RuntimeRequest): AsyncIterable<RuntimeEvent>;
}
