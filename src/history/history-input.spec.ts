import { describe, expect, it } from 'vitest';
import { renderHistoryInput, type WindowMessage } from './history-input.js';

const at = (iso: string) => new Date(iso);

const MESSAGES: WindowMessage[] = [
  {
    channel: 'English',
    speaker: 'User',
    text: 'I goed to the shop',
    createdAt: at('2026-09-28T08:05:00Z'),
  },
  {
    channel: 'English',
    speaker: 'english-coach',
    text: 'You went to the shop.',
    createdAt: at('2026-09-28T08:05:30Z'),
  },
  {
    channel: '-100123:7',
    speaker: 'User',
    text: 'Buy milk',
    createdAt: at('2026-09-28T23:10:00Z'),
  },
];

const TRANSCRIPT = [
  '[Chat history]',
  '2026-09-28 10:05 [English] User: I goed to the shop',
  '2026-09-28 10:05 [English] english-coach: You went to the shop.',
  '2026-09-29 01:10 [-100123:7] User: Buy milk',
  '[End of chat history]',
].join('\n');

describe('renderHistoryInput', () => {
  it('puts the transcript in local time in place of {{history}}', () => {
    expect(
      renderHistoryInput(
        'Review these chats:\n{{history}}\nSuggest fixes.',
        MESSAGES,
        'Europe/Berlin',
      ),
    ).toEqual({
      input: `Review these chats:\n${TRANSCRIPT}\nSuggest fixes.`,
      dropped: 0,
    });
  });

  it('puts the transcript after the input when there is no placeholder', () => {
    expect(
      renderHistoryInput('Review these chats.', MESSAGES, 'Europe/Berlin')
        .input,
    ).toBe(`Review these chats.\n\n${TRANSCRIPT}`);
  });

  it('keeps replacement patterns in messages as written', () => {
    const message = { ...MESSAGES[0]!, text: "costs $& or $'" };
    expect(renderHistoryInput('{{history}}', [message], 'UTC').input).toContain(
      "User: costs $& or $'",
    );
  });

  it('says when the window is empty', () => {
    expect(renderHistoryInput('Review.', [], 'UTC')).toEqual({
      input: 'Review.\n\n[No messages in this window]',
      dropped: 0,
    });
  });

  it('keeps the newest messages that fit the budget, and says how many it left out', () => {
    const newest = [
      '2026-09-28 08:05 [English] english-coach: You went to the shop.',
      '2026-09-28 23:10 [-100123:7] User: Buy milk',
    ];
    const budget = newest.join('\n').length;

    const { input, dropped } = renderHistoryInput(
      '{{history}}',
      MESSAGES,
      'UTC',
      budget,
    );

    expect(dropped).toBe(1);
    expect(input).toBe(
      [
        '[Chat history]',
        '[1 earlier message left out to fit]',
        ...newest,
        '[End of chat history]',
      ].join('\n'),
    );
  });

  it('cuts a newest message that alone is over the budget', () => {
    const long = { ...MESSAGES[0]!, text: 'x'.repeat(100) };

    const { input, dropped } = renderHistoryInput(
      '{{history}}',
      [MESSAGES[0]!, long],
      'UTC',
      40,
    );

    expect(dropped).toBe(1);
    const line = input.split('\n')[2]!;
    expect(line).toHaveLength(40);
    expect(line).toMatch(/^2026-09-28 08:05 \[English\] User: x+…$/);
  });
});
