import { Injectable, Logger } from '@nestjs/common';
import {
  AgentManager,
  TurnError,
  type TurnResult,
} from '../agents/agent-manager.js';
import type { Author } from '../history/message-history.service.js';
import type { InboundMessage } from './channel-adapter.js';
import { ChannelSender } from './channel-sender.js';
import { ChannelTurns, type RoutedChannel } from './channel-stages.js';
import { ToolApprovals } from './tool-approvals.js';

/** Posted instead of an answer when a turn fails. */
export function failureText(error: unknown): string {
  if (error instanceof TurnError && error.interrupted) {
    return (
      `Pero stopped before it answered. ` +
      `Send the message again once Pero is back.`
    );
  }
  const reason =
    error instanceof TurnError
      ? error.message
      : 'Pero failed to run the turn; see pero logs';
  return `Pero couldn't answer: ${reason.replace(/\.$/, '')}.`;
}

/**
 * Hands each routed message to the Agent manager and posts the answer, or
 * a short failure notice, back to the Channel and its history.
 */
@Injectable()
export class AgentChannelTurns extends ChannelTurns {
  private readonly logger = new Logger('Channels');
  /** Each accepted turn until its reply has been sent. */
  private readonly active = new Set<Promise<void>>();

  constructor(
    private readonly agents: AgentManager,
    private readonly sender: ChannelSender,
    private readonly approvals: ToolApprovals,
  ) {
    super();
  }

  handle(
    channel: RoutedChannel,
    message: InboundMessage,
    messageId: number,
    attachments: readonly string[],
  ): Promise<void> {
    const turn = this.agents.runTurn({
      channelId: channel.id,
      messageId,
      input: message.content.text,
      attachments,
      approve: this.approvals.approverFor(channel),
    });
    const task = this.reply(channel, turn);
    this.active.add(task);
    void task.then(() => this.active.delete(task));
    return Promise.resolve();
  }

  /** Settles once every accepted turn has answered. */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.all(this.active);
  }

  async drain(): Promise<void> {
    await this.agents.drain();
    await this.idle();
  }

  /** Posts what `turn` produced to `channel`; never throws. */
  private async reply(
    channel: RoutedChannel,
    turn: Promise<TurnResult | null>,
  ): Promise<void> {
    let text: string;
    let author: Author;
    try {
      const result = await turn;
      if (!result?.text) return;
      text = result.text;
      author = {
        origin: 'agent',
        agent: result.agentName,
        sessionId: result.sessionId,
      };
    } catch (error) {
      // `/stop` has answered for it already.
      if (error instanceof TurnError && error.stopped) return;
      text = failureText(error);
      author = { origin: 'pero' };
    }
    try {
      await this.sender.post(channel, text, author);
    } catch (error) {
      this.logger.warn(
        `Failed to reply in ${channel.integrationKind} Channel ${channel.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
