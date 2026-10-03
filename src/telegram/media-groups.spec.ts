import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../channels/channel-adapter.js';
import {
  groupChat,
  inboundMessage,
  privateChat,
} from '../channels/testing/fake-channel-adapter.js';
import { joinParts, MediaGroups } from './media-groups.js';

const CHAT = privateChat('1234');

function photo(ref: string, text = ''): InboundMessage {
  return inboundMessage(CHAT, {
    text,
    attachments: [{ ref, type: 'image/jpeg', name: null, size: null }],
  });
}

describe('MediaGroups', () => {
  let delivered: InboundMessage[];
  let groups: MediaGroups;

  beforeEach(() => {
    vi.useFakeTimers();
    delivered = [];
    groups = new MediaGroups((message) => {
      delivered.push(message);
      return Promise.resolve();
    }, 1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands on an album once no part has come for a while', async () => {
    const first = photo('a', 'Which one?');
    groups.add('album', first);
    await vi.advanceTimersByTimeAsync(900);
    groups.add('album', photo('b'));
    await vi.advanceTimersByTimeAsync(900);
    expect(delivered).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);

    expect(delivered).toEqual([
      {
        ...first,
        content: {
          text: 'Which one?',
          attachments: [
            { ref: 'a', type: 'image/jpeg', name: null, size: null },
            { ref: 'b', type: 'image/jpeg', name: null, size: null },
          ],
        },
      },
    ]);
  });

  it('keeps albums of different chats apart', async () => {
    groups.add('album', photo('a'));
    groups.add(
      'album',
      inboundMessage(groupChat('-100'), {
        text: '',
        attachments: [{ ref: 'b', type: 'image/jpeg', name: null, size: null }],
      }),
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(delivered.map((message) => message.chat.key)).toEqual([
      '1234',
      '-100',
    ]);
  });

  it('hands on every waiting album when flushed', async () => {
    groups.add('album', photo('a'));

    await groups.flushAll();

    expect(delivered).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(delivered).toHaveLength(1);
  });
});

describe('joinParts', () => {
  it("orders the parts as sent, joining their captions, with the first part's IDs", () => {
    const first = photo('a', 'Left');
    const second = photo('b');
    const third = photo('c', 'Right');

    expect(joinParts([third, first, second])).toEqual({
      ...first,
      content: {
        text: 'Left\n\nRight',
        attachments: [
          { ref: 'a', type: 'image/jpeg', name: null, size: null },
          { ref: 'b', type: 'image/jpeg', name: null, size: null },
          { ref: 'c', type: 'image/jpeg', name: null, size: null },
        ],
      },
    });
  });

  it('joins an album of files', () => {
    const first = inboundMessage(CHAT, {
      text: '',
      attachments: [
        { ref: 'a', type: 'application/pdf', name: 'a.pdf', size: 1 },
      ],
    });
    const second = inboundMessage(CHAT, {
      text: 'Both',
      attachments: [{ ref: 'b', type: 'text/csv', name: 'b.csv', size: 2 }],
    });

    expect(joinParts([second, first]).content).toEqual({
      text: 'Both',
      attachments: [
        { ref: 'a', type: 'application/pdf', name: 'a.pdf', size: 1 },
        { ref: 'b', type: 'text/csv', name: 'b.csv', size: 2 },
      ],
    });
  });
});
