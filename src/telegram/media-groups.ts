import type { InboundMessage } from '../channels/channel-adapter.js';

/**
 * How long an album waits for its next part. Telegram sends an album's
 * parts as separate messages within moments of each other.
 */
export const MEDIA_GROUP_WAIT_MS = 1_500;

interface PendingGroup {
  parts: InboundMessage[];
  timer: NodeJS.Timeout;
}

/**
 * Joins the parts of a Telegram album, such as several photos sent at once,
 * into one message, so that Pero answers the album once rather than each
 * photo. A group is handed on once no part has arrived for `waitMs`.
 */
export class MediaGroups {
  private readonly pending = new Map<string, PendingGroup>();
  /** Groups handed on that have not been handled yet. */
  private readonly delivering = new Set<Promise<void>>();

  /** `deliver` hands a joined album on; it must never reject. */
  constructor(
    private readonly deliver: (message: InboundMessage) => Promise<void>,
    private readonly waitMs = MEDIA_GROUP_WAIT_MS,
  ) {}

  /** Adds `part` of album `groupId`, waiting for the rest. */
  add(groupId: string, part: InboundMessage): void {
    const key = `${part.chat.key}:${groupId}`;
    const group = this.pending.get(key);
    if (group !== undefined) clearTimeout(group.timer);
    const parts = [...(group?.parts ?? []), part];
    this.pending.set(key, {
      parts,
      timer: setTimeout(() => this.flush(key), this.waitMs),
    });
  }

  /** Hands on every album still waiting and settles once all are handled. */
  async flushAll(): Promise<void> {
    for (const key of this.pending.keys()) this.flush(key);
    await Promise.all(this.delivering);
  }

  private flush(key: string): void {
    const group = this.pending.get(key);
    if (group === undefined) return;
    clearTimeout(group.timer);
    this.pending.delete(key);
    const delivery = this.deliver(joinParts(group.parts));
    this.delivering.add(delivery);
    void delivery.then(() => this.delivering.delete(delivery));
  }
}

/**
 * One message of an album's `parts`, in the order Telegram sent them: the
 * first part's IDs, which make redelivery of the album a duplicate, every
 * caption, and every file.
 */
export function joinParts(parts: readonly InboundMessage[]): InboundMessage {
  const sorted = [...parts].sort(
    (a, b) => Number(a.messageId) - Number(b.messageId),
  );
  const first = sorted[0]!;
  return {
    ...first,
    content: {
      text: sorted
        .map((part) => part.content.text)
        .filter((text) => text !== '')
        .join('\n\n'),
      attachments: sorted.flatMap((part) => part.content.attachments ?? []),
    },
  };
}
