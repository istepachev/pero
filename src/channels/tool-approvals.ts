import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ToolApproval,
  ToolApprovalRequest,
  ToolApprover,
} from '../runtimes/agent-runtime.js';
import type { ActionResult, InboundAction } from './channel-adapter.js';
import { ChannelSender } from './channel-sender.js';
import type { RoutedChannel } from './channel-stages.js';

/** How long a request waits for an answer; tests shorten it. */
export const TOOL_APPROVAL_TIMEOUT_MS = Symbol('TOOL_APPROVAL_TIMEOUT_MS');

export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

const ALLOW = 'allow';
const DENY = 'deny';

/** Why a request ended without the owner's answer. */
type Unanswered = 'timeout' | 'aborted' | 'stopping';

/** How a request ended. */
type Outcome =
  { answer: 'allow' | 'deny'; by: string } | { answer: Unanswered };

interface Pending {
  channelKey: string;
  messageId: string;
  resolve(outcome: Outcome): void;
}

/** Posted in the Channel to ask about `summary`. */
export function approvalText(agentName: string, summary: string): string {
  return `Agent ${agentName} wants to use a tool:\n${summary}`;
}

/**
 * Asks the owner in a Channel whether its Agent may use a tool: posts the
 * request with Allow and Deny buttons, which anyone in the chat may press,
 * and waits for the answer. A request not answered in time, whose turn
 * ends, or that Pero outlives by stopping is denied. Nothing of it joins
 * the Channel's history.
 */
@Injectable()
export class ToolApprovals {
  private readonly logger = new Logger('Channels');
  private readonly pending = new Map<string, Pending>();
  /** Set once Pero stops listening, when no answer can arrive. */
  private closed = false;

  constructor(
    private readonly sender: ChannelSender,
    @Inject(TOOL_APPROVAL_TIMEOUT_MS) private readonly timeoutMs: number,
  ) {}

  /** The approver for turns in `channel`. */
  approverFor(channel: RoutedChannel): ToolApprover {
    return (request) => this.ask(channel, request);
  }

  /** Answers a pressed button; one Pero no longer waits on has expired. */
  onAction(action: InboundAction): Promise<ActionResult> {
    const [id, answer] = action.actionId.split(':');
    const pending = id === undefined ? undefined : this.pending.get(id);
    if (
      pending === undefined ||
      (answer !== ALLOW && answer !== DENY) ||
      pending.channelKey !== action.channel.key ||
      pending.messageId !== action.messageId
    ) {
      return Promise.resolve({ notice: 'This request has expired' });
    }
    pending.resolve({
      answer,
      by: action.senderName ?? `user ${action.senderId}`,
    });
    return Promise.resolve({
      notice: answer === ALLOW ? 'Allowed' : 'Denied',
    });
  }

  /** Denies every open request, as Pero stops and can no longer hear. */
  closeAll(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.resolve({ answer: 'stopping' });
    }
  }

  private async ask(
    channel: RoutedChannel,
    request: ToolApprovalRequest,
  ): Promise<ToolApproval> {
    if (request.signal.aborted) return this.denied('aborted');
    if (this.closed) return this.denied('stopping');
    const id = randomBytes(6).toString('base64url');
    const text = approvalText(channel.agent.name, request.summary);
    const where = `${channel.integrationKind} Channel ${channel.id}`;

    let settle!: (outcome: Outcome) => void;
    const outcome = new Promise<Outcome>((resolve) => {
      settle = resolve;
    });
    const sent = await this.sender.send(
      channel.integrationKind,
      channel.address,
      {
        text,
        buttons: [
          [
            { id: `${id}:${ALLOW}`, label: 'Allow' },
            { id: `${id}:${DENY}`, label: 'Deny' },
          ],
        ],
      },
    );
    this.logger.log(`Asked about ${request.tool} in ${where}`);

    const timer = setTimeout(
      () => settle({ answer: 'timeout' }),
      this.timeoutMs,
    );
    const onAbort = () => settle({ answer: 'aborted' });
    request.signal.addEventListener('abort', onAbort, { once: true });
    this.pending.set(id, {
      channelKey: channel.externalKey,
      messageId: sent.messageId,
      resolve: settle,
    });
    if (request.signal.aborted) settle({ answer: 'aborted' });

    const result = await outcome;
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
    this.pending.delete(id);
    this.logger.log(`${request.tool} in ${where}: ${result.answer}`);

    try {
      await this.sender.edit(
        channel.integrationKind,
        channel.address,
        sent.messageId,
        { text: `${text}\n\n${this.describe(result)}` },
      );
    } catch (error) {
      this.logger.warn(
        `Failed to mark the tool request in ${where} as answered: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return result.answer === ALLOW
      ? { allow: true }
      : this.denied(result.answer);
  }

  /** The reason the Agent is given for a request that was not allowed. */
  private denied(answer: 'deny' | Unanswered): ToolApproval {
    const reasons: Record<typeof answer, string> = {
      deny: 'the owner denied it',
      timeout: `no one answered within ${this.minutes()}`,
      aborted: 'the turn ended',
      stopping: 'Pero is stopping',
    };
    return { allow: false, reason: reasons[answer] };
  }

  /** The line added to the request once it has ended. */
  private describe(outcome: Outcome): string {
    switch (outcome.answer) {
      case 'allow':
        return `✅ Allowed by ${outcome.by}`;
      case 'deny':
        return `❌ Denied by ${outcome.by}`;
      case 'timeout':
        return `⌛ Denied: no answer within ${this.minutes()}`;
      case 'aborted':
        return 'Cancelled: the turn ended';
      case 'stopping':
        return 'Cancelled: Pero is stopping';
    }
  }

  /** The timeout in words, such as `10 minutes`. */
  private minutes(): string {
    const [count, unit] =
      this.timeoutMs < 60_000
        ? [Math.round(this.timeoutMs / 1000), 'second']
        : [Math.round(this.timeoutMs / 60_000), 'minute'];
    return `${count} ${unit}${count === 1 ? '' : 's'}`;
  }
}
