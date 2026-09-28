import { Injectable } from '@nestjs/common';
import type { IntegrationKind } from '../persistence/entities/sql.js';
import type {
  ChannelAdapter,
  ChannelAddress,
  OutboundMessage,
  SentMessage,
} from './channel-adapter.js';

/** The connected adapters, one per integration, and sending through them. */
@Injectable()
export class ChannelSender {
  private readonly adapters = new Map<IntegrationKind, ChannelAdapter>();

  add(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.kind)) {
      throw new Error(`A ${adapter.kind} adapter is already connected`);
    }
    this.adapters.set(adapter.kind, adapter);
  }

  all(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  send(
    kind: IntegrationKind,
    address: ChannelAddress,
    message: OutboundMessage,
  ): Promise<SentMessage> {
    const adapter = this.adapters.get(kind);
    if (!adapter) {
      return Promise.reject(new Error(`No ${kind} adapter is connected`));
    }
    return adapter.send(address, message);
  }
}
