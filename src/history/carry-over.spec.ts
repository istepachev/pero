import { describe, expect, it } from 'vitest';
import { type CarriedMessage, withEarlierConversation } from './carry-over.js';

const at = (iso: string) => new Date(iso);

const MESSAGES: CarriedMessage[] = [
  { speaker: 'User', text: 'Buy milk', createdAt: at('2026-09-28T08:05:00Z') },
  {
    speaker: 'groceries',
    text: 'Added milk.\nAnything else?',
    createdAt: at('2026-09-28T08:05:30Z'),
  },
  { speaker: 'User', text: 'Eggs', createdAt: at('2026-09-28T23:10:00Z') },
];

describe('withEarlierConversation', () => {
  it('puts a marked transcript in local time before the input', () => {
    expect(
      withEarlierConversation('And bread', MESSAGES, 'Europe/Berlin'),
    ).toBe(
      [
        '[Earlier conversation in this chat, from a previous session]',
        '2026-09-28 10:05 User: Buy milk',
        '2026-09-28 10:05 groceries: Added milk.',
        'Anything else?',
        '2026-09-29 01:10 User: Eggs',
        '[End of earlier conversation]',
        '',
        'And bread',
      ].join('\n'),
    );
  });

  it('leaves the input alone when there is nothing to carry', () => {
    expect(withEarlierConversation('Hello', [], 'UTC')).toBe('Hello');
  });

  it('keeps the newest messages that fit the budget', () => {
    // The two newest lines and the newline between them, exactly.
    const budget =
      '2026-09-28 08:05 groceries: Added milk.\nAnything else?'.length +
      1 +
      '2026-09-28 23:10 User: Eggs'.length;

    const input = withEarlierConversation('Next', MESSAGES, 'UTC', budget);

    expect(input).not.toContain('Buy milk');
    expect(input).toContain('groceries: Added milk.\nAnything else?');
    expect(input).toContain('User: Eggs');
  });

  it('cuts a newest message that alone is over the budget', () => {
    const long: CarriedMessage = {
      speaker: 'User',
      text: 'x'.repeat(100),
      createdAt: at('2026-09-28T08:00:00Z'),
    };

    const input = withEarlierConversation('Next', [long], 'UTC', 40);

    const line = input.split('\n')[1]!;
    expect(line).toHaveLength(40);
    expect(line).toMatch(/^2026-09-28 08:00 User: x+…$/);
  });
});
