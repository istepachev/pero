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
  input: string;
  /**
   * Files the owner sent with the input, such as images and PDFs, as
   * absolute paths of saved files; the input names each one too. The
   * adapter shows the model those its provider takes with the input, and
   * leaves the rest for it to read.
   */
  attachments?: readonly string[];
  /** `Persona.md`, `Instructions.md`, then the Channel note's own. */
  instructions: string;
  /** Model and effort; the adapter omits each null one. */
  providerOptions: ProviderOptions;
  /** The effective folder; the adapter passes it to the SDK explicitly. */
  workingDirectory: string;
  /**
   * Codex only: lets the Agent work in a folder that is not a Git
   * repository. Absent means no; other providers ignore it.
   */
  skipGitRepoCheck?: boolean;
  /** The conversation to resume; absent to start a new one. */
  providerSessionId?: string;
  /**
   * Claude only: keeps the conversation off disk, for a turn no one
   * resumes, such as a Workflow run's. Absent means it is saved. Codex
   * ignores it.
   */
  ephemeral?: boolean;
  /** Tools the Agent may use; the adapter maps it to its provider's controls. */
  toolPolicy: ToolPolicy;
  /**
   * Pero's system folder; absent outside a workspace. Claude only: an
   * `ask` Agent's edits under it always ask, even in its own folder.
   * Codex's sandbox can't leave a folder out, so Codex ignores it.
   */
  systemFolder?: string;
  /**
   * The guide to Pero's settings, which the instructions name; absent
   * outside a workspace. Claude only: an `ask` Agent reads it without
   * asking, even when it is outside its folder.
   */
  guideFile?: string;
  /**
   * Where the files people send are saved; absent outside a workspace.
   * Claude only: an `ask` Agent reads them without asking, even when they
   * are outside its folder.
   */
  attachmentsFolder?: string;
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
  /**
   * How full the conversation's context is once the turn has answered, in
   * tokens, and the model's window when the provider says.
   */
  | { type: 'usage'; contextTokens: number; contextWindow: number | null }
  /** The whole reply once the turn has finished. */
  | { type: 'result'; text: string };

/**
 * Why a turn failed: signed out of the provider, aborted through its
 * signal, the provider no longer has the conversation it was asked to
 * resume (`session_lost`, such as after a restore without the provider's
 * own session store), or anything else.
 */
export type RuntimeErrorKind = 'auth' | 'cancelled' | 'session_lost' | 'failed';

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
