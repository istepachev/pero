import { Injectable } from '@nestjs/common';
import type { ChatKind, IntegrationKind } from '../persistence/entities/sql.js';
import type { InboundChat } from './channel-adapter.js';

/** How often one chat that is not allowed may get the same pairing hint. */
export const PAIRING_HINT_INTERVAL_MS = 60 * 60 * 1000;

/** How many chats are remembered; the least recently seen go first. */
export const PAIRING_REQUESTS_LIMIT = 100;

/**
 * How long the owner counts as waiting at the terminal after setup last
 * said so; setup says so on every look, about once a second.
 */
export const PAIRING_WATCH_MS = 5_000;

/**
 * What a chat that is not allowed is told: to confirm in the terminal
 * where setup waits for it, or how to allow it there.
 */
export type PairingHint = 'confirm' | 'allow';

/** A chat that is not allowed and has tried to reach Pero. */
export interface PairingRequest {
  integrationKind: IntegrationKind;
  chatKey: string;
  kind: ChatKind;
  title: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** When the chat last got a pairing hint. */
  hintedAt: Date | null;
  /** Which hint it got then. */
  hinted: PairingHint | null;
}

/**
 * Chats that are not allowed and have tried to reach Pero, kept in memory
 * so the owner can find them and each gets the same pairing hint at most
 * once per interval. Forgotten on restart, which only allows one more hint.
 */
@Injectable()
export class PairingRequests {
  // A Map iterates in insertion order; re-inserting on each sighting keeps
  // the least recently seen chat first.
  private readonly requests = new Map<string, PairingRequest>();
  /** Until when the owner waits at the terminal, by integration. */
  private readonly watchedUntil = new Map<IntegrationKind, number>();

  /**
   * Notes that the owner waits at the terminal to confirm a chat of
   * `integrationKind`, for the next `PAIRING_WATCH_MS`.
   */
  watch(integrationKind: IntegrationKind): void {
    this.watchedUntil.set(integrationKind, Date.now() + PAIRING_WATCH_MS);
  }

  /**
   * Notes an attempt from `chat`; `hint` says which hint to answer it
   * with, if any.
   */
  record(
    integrationKind: IntegrationKind,
    chat: InboundChat,
  ): { hint: PairingHint | null } {
    const now = new Date();
    const id = `${integrationKind}:${chat.key}`;
    const previous = this.requests.get(id);
    const wanted: PairingHint =
      now.getTime() < (this.watchedUntil.get(integrationKind) ?? 0)
        ? 'confirm'
        : 'allow';
    const hint =
      previous?.hintedAt == null ||
      previous.hinted !== wanted ||
      now.getTime() - previous.hintedAt.getTime() >= PAIRING_HINT_INTERVAL_MS
        ? wanted
        : null;

    this.requests.delete(id);
    this.requests.set(id, {
      integrationKind,
      chatKey: chat.key,
      kind: chat.kind,
      title: chat.title ?? previous?.title ?? null,
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
      hintedAt: hint !== null ? now : (previous?.hintedAt ?? null),
      hinted: hint ?? previous?.hinted ?? null,
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
