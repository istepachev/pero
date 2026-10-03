import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Logger } from '@nestjs/common';
import {
  type CanUseTool,
  type EffortLevel,
  type Options,
  type PermissionResult,
  query as sdkQuery,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { imageTypeOf } from '../../common/images.js';
import { CLAUDE_EFFORTS } from '../../config/provider-options.js';
import {
  type AgentRuntime,
  RuntimeError,
  type RuntimeEvent,
  type RuntimeRequest,
} from '../agent-runtime.js';
import {
  classifyClaudeFailure,
  newTurnState,
  normalizeClaudeMessage,
} from './claude-events.js';
import { editDecision } from './edit-policy.js';
import { isPdf, pdfPageCount } from './pdf-pages.js';

/** Starts a Claude Code turn; the SDK's `query`, or a fake in tests. */
export type ClaudeQuery = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage>;

/**
 * Variables that would make Claude Code bill an API account instead of the
 * owner's subscription sign-in. Pero never passes them on.
 */
const API_BILLING_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/** How much of Claude Code's own output a failure may quote. */
const STDERR_LINES = 20;

/**
 * The largest image Claude is shown with the input. Sent as base64, it
 * grows by a third, which keeps it within the API's 5 MB; a larger one is
 * left for Claude to read from where the input says it is saved.
 */
export const MAX_INLINE_IMAGE_BYTES = 3_750_000;

/**
 * The largest PDF Claude is shown with the input, and the most pages it
 * may have, as far as they can be counted: as many as Claude Code's `Read`
 * takes at once, since every page stays in the conversation. A larger one
 * is left for Claude to read, a few pages at a time.
 */
export const MAX_INLINE_PDF_BYTES = 5_000_000;
export const MAX_INLINE_PDF_PAGES = 20;

/**
 * How much Claude is shown with one input in all, which keeps a message
 * with many files, in base64, within the API's 32 MB request; the files
 * past it are left for Claude to read.
 */
export const MAX_INLINE_TOTAL_BYTES = 20_000_000;

/** How much of a tool's input an approval request shows. */
const MAX_SUMMARY_INPUT = 200;

/** Why a tool was refused when no one can be asked. */
export const NO_APPROVER =
  "no one can approve tools here yet; the owner can let this Agent's tools " +
  'run without asking with permissions set to bypass';

/** Why an edit of the system folder was refused when no one can be asked. */
export const NO_SYSTEM_APPROVER =
  "Pero's system folder changes only with the owner's approval, and no " +
  'one can approve here';

/** Starts the summary of an edit of the system folder, for the owner. */
const SYSTEM_EDIT = "Change Pero's settings";

/**
 * Runs Agents on Claude Code through the Claude Agent SDK, signed in with
 * the owner's subscription. Agents work like Claude Code in their folder:
 * its system prompt with the Agent's instructions appended, and the
 * owner's user, project, and local settings, such as CLAUDE.md files.
 */
export class ClaudeRuntime implements AgentRuntime {
  readonly kind = 'claude' as const;
  private readonly logger = new Logger('Claude');
  private readonly env: Record<string, string | undefined>;

  constructor(
    private readonly query: ClaudeQuery = sdkQuery,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    const dropped = API_BILLING_ENV.filter((name) => env[name] !== undefined);
    if (dropped.length > 0) {
      this.logger.warn(
        `Ignoring ${dropped.join(' and ')}: Pero uses Claude with the Claude ` +
          `Code sign-in of the account running Pero`,
      );
    }
    this.env = Object.fromEntries(
      Object.entries(env).filter(([name]) => !API_BILLING_ENV.includes(name)),
    );
  }

  async *execute(request: RuntimeRequest): AsyncIterable<RuntimeEvent> {
    if (request.signal.aborted) {
      throw new RuntimeError('cancelled', 'The turn was aborted');
    }
    // Its own controller, so the process also stops when the caller stops
    // reading early.
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    request.signal.addEventListener('abort', onAbort, { once: true });
    const stderr: string[] = [];
    const state = newTurnState();
    try {
      const messages = this.query({
        prompt: await claudePrompt(request),
        options: this.options(request, abort, (data) => {
          stderr.push(...data.split('\n'));
          stderr.splice(0, Math.max(0, stderr.length - STDERR_LINES));
        }),
      });
      for await (const message of messages) {
        yield* normalizeClaudeMessage(message, state);
      }
      if (!state.finished) {
        throw new RuntimeError(
          'failed',
          'Claude Code stopped before finishing the turn',
        );
      }
    } catch (error) {
      throw classifyClaudeFailure(error, {
        aborted: request.signal.aborted,
        stderr: stderr.join('\n'),
      });
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      if (!state.finished) abort.abort();
    }
  }

  /** The SDK options for one turn of `request`. */
  private options(
    request: RuntimeRequest,
    abort: AbortController,
    stderr: (data: string) => void,
  ): Options {
    const { model, effort } = request.providerOptions;
    return {
      cwd: request.workingDirectory,
      ...(model === null ? {} : { model }),
      ...(effort === null ? {} : { effort: claudeEffort(effort) }),
      ...(request.providerSessionId === undefined
        ? {}
        : { resume: request.providerSessionId }),
      // Not under ~/.claude/projects, where nothing would read it again.
      ...(request.ephemeral === true ? { persistSession: false } : {}),
      systemPrompt:
        request.instructions === ''
          ? { type: 'preset', preset: 'claude_code' }
          : {
              type: 'preset',
              preset: 'claude_code',
              append: request.instructions,
            },
      settingSources: ['user', 'project', 'local'],
      ...(request.toolPolicy.permissions === 'bypass'
        ? {
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
          }
        : {
            // Claude Code reads in its folder without asking, and hands
            // everything else to Pero, which decides about edits itself.
            permissionMode: 'default',
            canUseTool: askOwner(request),
          }),
      abortController: abort,
      env: this.env,
      stderr,
    };
  }
}

type ContentBlock = Exclude<
  SDKUserMessage['message']['content'],
  string
>[number];

/**
 * The turn's prompt: its input, after the images and PDFs sent with it
 * when there are any Claude can be shown.
 */
async function claudePrompt(
  request: RuntimeRequest,
): Promise<string | AsyncIterable<SDKUserMessage>> {
  const blocks: ContentBlock[] = [];
  let budget = MAX_INLINE_TOTAL_BYTES;
  for (const path of request.attachments ?? []) {
    const shown = await inlineBlock(path, budget);
    if (shown === null) continue;
    blocks.push(shown.block);
    budget -= shown.size;
  }
  if (blocks.length === 0) return request.input;
  const message: SDKUserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: [...blocks, { type: 'text', text: request.input }],
    },
    parent_tool_use_id: null,
  };
  return (async function* () {
    yield message;
  })();
}

/**
 * The file saved at `path` as a block Claude is shown with the input, and
 * its size; null for a file it reads instead: one of another type, larger
 * than its type's limit or the `budget` left, or a PDF of too many pages.
 */
async function inlineBlock(
  path: string,
  budget: number,
): Promise<{ block: ContentBlock; size: number } | null> {
  const image = imageTypeOf(path);
  const pdf = extname(path).toLowerCase() === '.pdf';
  if (image === null && !pdf) return null;
  const limit = image === null ? MAX_INLINE_PDF_BYTES : MAX_INLINE_IMAGE_BYTES;
  const { size } = await stat(path);
  if (size > Math.min(limit, budget)) return null;
  const data = await readFile(path);
  if (image !== null) {
    const source = {
      type: 'base64' as const,
      media_type: image,
      data: data.toString('base64'),
    };
    return { block: { type: 'image', source }, size };
  }
  if (!isPdf(data) || (pdfPageCount(data) ?? 0) > MAX_INLINE_PDF_PAGES) {
    return null;
  }
  const source = {
    type: 'base64' as const,
    media_type: 'application/pdf' as const,
    data: data.toString('base64'),
  };
  return { block: { type: 'document', source }, size };
}

/** `effort`, which the Agent service has checked against Claude's levels. */
function claudeEffort(effort: string): EffortLevel {
  if (!(CLAUDE_EFFORTS as readonly string[]).includes(effort)) {
    throw new RuntimeError('failed', `Claude has no effort level ${effort}`);
  }
  return effort as EffortLevel;
}

/**
 * Decides about each tool Claude Code leaves open: an edit in the Agent's
 * folder runs, except under the system folder, which asks like any other
 * tool, and so does reading Pero's guide or the files people sent.
 * Without an approver, or when asking fails, the tool is refused and
 * Claude is told why.
 */
function askOwner(request: RuntimeRequest): CanUseTool {
  const {
    approve,
    workingDirectory,
    systemFolder,
    guideFile,
    attachmentsFolder,
  } = request;
  return async (tool, input, { signal, title }) => {
    const decision = await editDecision(tool, input, {
      workingDirectory,
      ...(systemFolder === undefined ? {} : { systemFolder }),
      ...(guideFile === undefined ? {} : { guideFile }),
      ...(attachmentsFolder === undefined ? {} : { attachmentsFolder }),
    });
    if (decision === 'allow') return { behavior: 'allow', updatedInput: input };
    const system = decision === 'system';
    if (approve === undefined) {
      return deny(system ? NO_SYSTEM_APPROVER : NO_APPROVER);
    }
    const summary = title ?? summarize(tool, input);
    try {
      const answer = await approve({
        tool,
        summary: system ? `${SYSTEM_EDIT}: ${summary}` : summary,
        signal,
      });
      return answer.allow
        ? { behavior: 'allow', updatedInput: input }
        : deny(answer.reason);
    } catch (error) {
      return deny(
        `asking the owner failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}

function deny(reason: string): PermissionResult {
  return { behavior: 'deny', message: `Not allowed: ${reason}` };
}

/** One line saying what `tool` would do with `input`. */
export function summarize(
  tool: string,
  input: Record<string, unknown>,
): string {
  const detail =
    ['command', 'url', 'query', 'file_path']
      .map((key) => input[key])
      .find((value): value is string => typeof value === 'string') ??
    JSON.stringify(input);
  const line = detail.replace(/\s+/g, ' ').trim();
  return `${tool}: ${
    line.length > MAX_SUMMARY_INPUT
      ? `${line.slice(0, MAX_SUMMARY_INPUT - 1)}…`
      : line
  }`;
}
