import { Injectable } from '@nestjs/common';
import type { ChatKind, IntegrationKind } from '../persistence/entities/sql.js';
import type { InboundChat } from './channel-adapter.js';

/** How often one chat that is not allowed may get the pairing hint. */
export const PAIRING_HINT_INTERVAL_MS = 60 * 60 * 1000;

/** How many chats are remembered; the least recently seen go first. */
export const PAIRING_REQUESTS_LIMIT = 100;

/** A chat that is not allowed and has tried to reach Pero. */
export interface PairingRequest {
  integrationKind: IntegrationKind;
  chatKey: string;
  kind: ChatKind;
  title: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** When the chat last got the pairing hint. */
  hintedAt: Date | null;
}

/**
 * Chats that are not allowed and have tried to reach Pero, kept in memory
 * so the owner can find them and each gets the pairing hint at most once
 * per interval. Forgotten on restart, which only allows one more hint.
 */
@Injectable()
export class PairingRequests {
  // A Map iterates in insertion order; re-inserting on each sighting keeps
  // the least recently seen chat first.
  private readonly requests = new Map<string, PairingRequest>();

  /** Notes an attempt from `chat`; `hint` says whether to answer it. */
  record(
    integrationKind: IntegrationKind,
    chat: InboundChat,
  ): { hint: boolean } {
    const now = new Date();
    const id = `${integrationKind}:${chat.key}`;
    const previous = this.requests.get(id);
    const hint =
      previous?.hintedAt == null ||
      now.getTime() - previous.hintedAt.getTime() >= PAIRING_HINT_INTERVAL_MS;

    this.requests.delete(id);
    this.requests.set(id, {
      integrationKind,
      chatKey: chat.key,
      kind: chat.kind,
      title: chat.title ?? previous?.title ?? null,
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
      hintedAt: hint ? now : (previous?.hintedAt ?? null),
    });
    if (this.requests.size > PAIRING_REQUESTS_LIMIT) {
      const oldest = this.requests.keys().next().value!;
      this.requests.delete(oldest);
    }
    return { hint };
  }

  /** The integration's requests, most recently seen first. */
  recent(integrationKind: IntegrationKind): PairingRequest[] {
    return [...this.requests.values()]
      .filter((request) => request.integrationKind === integrationKind)
      .reverse();
  }
}
