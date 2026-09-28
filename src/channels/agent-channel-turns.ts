import { Injectable, Logger } from '@nestjs/common';
import {
  AgentManager,
  TurnError,
  type TurnResult,
} from '../agents/agent-manager.js';
import type { InboundMessage } from './channel-adapter.js';
import { ChannelSender } from './channel-sender.js';
import { ChannelTurns, type RoutedChannel } from './channel-stages.js';

/** Posted instead of an answer when a turn fails. */
export function failureText(agentName: string, error: unknown): string {
  if (error instanceof TurnError && error.interrupted) {
    return (
      `Pero stopped before Agent ${agentName} answered. ` +
      `Send the message again once Pero is back.`
    );
  }
  const reason =
    error instanceof TurnError
      ? error.message
      : 'Pero failed to run the turn; see pero logs';
  return `Agent ${agentName} couldn't answer: ${reason.replace(/\.$/, '')}.`;
}

/**
 * Hands each routed message to the Agent manager and sends the answer, or
 * a short failure notice, back to the Channel.
 */
@Injectable()
export class AgentChannelTurns extends ChannelTurns {
  private readonly logger = new Logger('Channels');
  /** Each accepted turn until its reply has been sent. */
  private readonly active = new Set<Promise<void>>();

  constructor(
    private readonly agents: AgentManager,
    private readonly sender: ChannelSender,
  ) {
    super();
  }

  handle(channel: RoutedChannel, message: InboundMessage): Promise<void> {
    const turn = this.agents.runTurn({
      channelId: channel.id,
      agentId: channel.agentId,
      input: message.content.text,
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

  /** Sends what `turn` produced to `channel`; never throws. */
  private async reply(
    channel: RoutedChannel,
    turn: Promise<TurnResult | null>,
  ): Promise<void> {
    let text: string | null;
    try {
      text = (await turn)?.text || null;
    } catch (error) {
      text = failureText(channel.agent.name, error);
    }
    if (text === null) return;
    try {
      await this.sender.send(channel.integrationKind, channel.address, {
        text,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to reply in ${channel.integrationKind} Channel ${channel.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
