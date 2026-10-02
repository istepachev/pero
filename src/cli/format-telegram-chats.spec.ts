import { describe, expect, it } from 'vitest';
import type { TelegramChats } from '../control/protocol.js';
import { formatAllowed, formatTelegramChats } from './format-telegram-chats.js';

const now = new Date('2026-09-28T10:05:00.000Z');
const allowedAt = '2026-09-28T09:00:00.000Z';

describe('formatTelegramChats', () => {
  it('lists allowed chats, then chats that asked to pair', () => {
    const chats: TelegramChats = {
      bot: 'pero_bot',
      allowed: [
        {
          chatId: '-1001234567890',
          kind: 'group',
          title: 'Household',
          bot: 'administrator',
          topics: true,
          problem: null,
          danger: null,
          allowedAt,
        },
        {
          chatId: '-4567',
          kind: 'group',
          title: 'Family',
          bot: 'member',
          topics: false,
          problem: "the bot isn't an administrator of Family (-4567)",
          danger: null,
          allowedAt,
        },
        {
          chatId: '1234',
          kind: 'private',
          title: 'Ada',
          bot: null,
          topics: null,
          problem: null,
          danger: null,
          allowedAt,
        },
      ],
      pairing: [
        {
          chatId: '-100999',
          kind: 'group',
          title: null,
          firstSeenAt: allowedAt,
          lastSeenAt: '2026-09-28T10:02:00.000Z',
        },
      ],
    };

    expect(formatTelegramChats(chats, now)).toBe(
      [
        'Bot: @pero_bot',
        '',
        'Allowed chats',
        '  ID              KIND     TITLE      TOPICS  BOT',
        '  -1001234567890  group    Household  on      administrator',
        '  -4567           group    Family     off     member, not an administrator',
        '  1234            private  Ada        —       —',
        '',
        "Warning: the bot isn't an administrator of Family (-4567)",
        '',
        'Asked to pair',
        '  ID       KIND   TITLE  LAST SEEN',
        '  -100999  group  —      3m 0s ago',
        'Allow one with pero telegram allow <chat-id>',
      ].join('\n'),
    );
  });

  it('explains how to pair a first chat', () => {
    expect(
      formatTelegramChats({ bot: null, allowed: [], pairing: [] }, now),
    ).toBe(
      [
        'Bot: not connected (see pero status)',
        '',
        'No chat is allowed yet. To pair one:',
        '  Create a private group (recommended), turn on Topics in its settings, and add the bot as an administrator;',
        '  or send the bot a direct message.',
        "  The bot answers a chat it does not serve with that chat's ID; allow it with pero telegram allow <chat-id>.",
      ].join('\n'),
    );
  });
});

describe('formatAllowed', () => {
  it('reminds about administrator rights and topics for a group', () => {
    expect(
      formatAllowed(
        {
          chatId: '-4567',
          kind: 'group',
          title: 'Family',
          bot: 'member',
          topics: false,
          problem: "the bot isn't an administrator of Family (-4567)",
          danger: null,
          allowedAt,
        },
        false,
      ),
    ).toBe(
      [
        'Allowed: group "Family" (-4567)',
        "Warning: the bot isn't an administrator of Family (-4567)",
        'Turn on Topics in the group settings to give each subject its own topic; Pero follows the new chat ID this gives the group.',
      ].join('\n'),
    );
  });

  it('puts the danger of a public group first', () => {
    expect(
      formatAllowed(
        {
          chatId: '-1001234567890',
          kind: 'group',
          title: 'Household',
          bot: 'administrator',
          topics: true,
          problem: null,
          danger: 'Household (-1001234567890) is a public group (@household)',
          allowedAt,
        },
        false,
      ),
    ).toBe(
      [
        'Allowed: group "Household" (-1001234567890)',
        'Danger: Household (-1001234567890) is a public group (@household)',
      ].join('\n'),
    );
  });

  it('says nothing more for a direct chat allowed again', () => {
    expect(
      formatAllowed(
        {
          chatId: '1234',
          kind: 'private',
          title: null,
          bot: null,
          topics: null,
          problem: null,
          danger: null,
          allowedAt,
        },
        true,
      ),
    ).toBe('Already allowed: direct chat 1234');
  });
});
