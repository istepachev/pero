import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PAIRING_HINT_INTERVAL_MS,
  PAIRING_REQUESTS_LIMIT,
  PAIRING_WATCH_MS,
  PairingRequests,
} from './pairing-requests.js';
import { groupChat, privateChat } from './testing/fake-channel-adapter.js';

describe('PairingRequests', () => {
  let requests: PairingRequests;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-09-28T10:00:00Z') });
    requests = new PairingRequests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hints a chat at most once per interval', () => {
    const chat = groupChat('-100', 'Family');

    expect(requests.record('telegram', chat)).toEqual({ hint: 'allow' });
    vi.advanceTimersByTime(PAIRING_HINT_INTERVAL_MS - 1);
    expect(requests.record('telegram', chat)).toEqual({ hint: null });
    vi.advanceTimersByTime(1);
    expect(requests.record('telegram', chat)).toEqual({ hint: 'allow' });
  });

  it('tells a chat to confirm in the terminal while setup waits there', () => {
    const chat = privateChat('7');
    expect(requests.record('telegram', chat)).toEqual({ hint: 'allow' });

    // Setup starts waiting: the chat hinted already is told again, once.
    requests.watch('telegram');
    expect(requests.record('telegram', chat)).toEqual({ hint: 'confirm' });
    expect(requests.record('telegram', chat)).toEqual({ hint: null });
    expect(requests.record('telegram', privateChat('8'))).toEqual({
      hint: 'confirm',
    });

    // Setup stopped looking: back to how to allow it.
    vi.advanceTimersByTime(PAIRING_WATCH_MS);
    expect(requests.record('telegram', chat)).toEqual({ hint: 'allow' });
  });

  it('remembers who asked, most recently seen first', () => {
    requests.record('telegram', groupChat('-100', 'Family'));
    vi.advanceTimersByTime(1000);
    requests.record('telegram', privateChat('7'));
    vi.advanceTimersByTime(1000);
    requests.record('telegram', groupChat('-100', null));

    expect(requests.recent('telegram')).toEqual([
      {
        integrationKind: 'telegram',
        chatKey: '-100',
        kind: 'group',
        title: 'Family',
        firstSeenAt: new Date('2026-09-28T10:00:00Z'),
        lastSeenAt: new Date('2026-09-28T10:00:02Z'),
        hintedAt: new Date('2026-09-28T10:00:00Z'),
        hinted: 'allow',
      },
      expect.objectContaining({ chatKey: '7', kind: 'private' }),
    ]);
  });

  it('forgets the least recently seen chat beyond the limit', () => {
    for (let i = 0; i <= PAIRING_REQUESTS_LIMIT; i++) {
      requests.record('telegram', privateChat(String(i)));
    }

    const keys = requests.recent('telegram').map((r) => r.chatKey);
    expect(keys).toHaveLength(PAIRING_REQUESTS_LIMIT);
    expect(keys).not.toContain('0');
    expect(keys[0]).toBe(String(PAIRING_REQUESTS_LIMIT));
    // A forgotten chat is hinted again.
    expect(requests.record('telegram', privateChat('0'))).toEqual({
      hint: 'allow',
    });
  });
});
