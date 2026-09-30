import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ChannelDetails,
  ChannelView,
  HistoryMessage,
} from '../control/protocol.js';
import {
  formatChannelDetails,
  formatChannelList,
  formatHistory,
} from './format-channels.js';

const general: ChannelView = {
  id: 1,
  integrationKind: 'telegram',
  key: '-1001234567890',
  title: 'Household',
  agent: 'main',
  agentEnabled: true,
  unanswered: null,
  createdAt: '2026-09-28T09:00:00.000Z',
};

const groceries: ChannelView = {
  ...general,
  id: 12,
  key: '-1001234567890:42',
  title: 'Groceries',
  agent: 'groceries',
};

const details: ChannelDetails = {
  ...groceries,
  nextTurn: {
    kind: 'resume',
    reason: null,
    from: null,
    sessionId: 3,
    carriesOver: false,
  },
  messages: 4,
  lastMessageAt: '2026-09-28T10:04:05.000Z',
};

const message = (fields: Partial<HistoryMessage>): HistoryMessage => ({
  id: 1,
  createdAt: '2026-09-28T10:04:05.000Z',
  direction: 'in',
  origin: 'user',
  agent: 'groceries',
  workflow: null,
  senderId: '1234',
  text: 'Milk',
  ...fields,
});

describe('Channel formatting', () => {
  const zone = process.env.TZ;

  // A fixed offset, so local time is provably not the recorded UTC.
  beforeAll(() => {
    process.env.TZ = 'Asia/Tashkent';
  });

  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it('lists Channels with the Agent that answers in each now', () => {
    expect(
      formatChannelList([
        general,
        {
          ...groceries,
          agentEnabled: false,
          unanswered: 'Agent groceries is disabled',
          title: null,
        },
        {
          ...groceries,
          id: 13,
          key: '-1001234567890:43',
          title: 'Chores',
          agent: null,
          agentEnabled: false,
          unanswered: 'no Agent claims "Chores"',
        },
      ]),
    ).toBe(
      [
        'ID  CHANNEL                     TITLE      AGENT',
        '1   telegram -1001234567890     Household  main',
        '12  telegram -1001234567890:42  —          groceries (disabled)',
        '13  telegram -1001234567890:43  Chores     none',
      ].join('\n'),
    );
  });

  it('explains how Channels come to be when there is none', () => {
    expect(formatChannelList([])).toMatch(
      /^No Channels yet\. .*pero telegram allow/,
    );
  });

  it('shows a Channel with its next turn and history in local time', () => {
    expect(formatChannelDetails(details)).toBe(
      [
        'Channel 12 "Groceries"',
        '  address    telegram -1001234567890:42',
        '  agent      groceries',
        '  next turn  resumes Session 3',
        '  history    4 messages, the latest at 2026-09-28 15:04',
        '  created    2026-09-28 14:00',
      ].join('\n'),
    );
  });

  it('says why no one answers', () => {
    expect(
      formatChannelDetails({
        ...details,
        agent: null,
        agentEnabled: false,
        unanswered: '"Groceries" is claimed by a.md and b.md',
        nextTurn: null,
        messages: 0,
        lastMessageAt: null,
      }),
    ).toBe(
      [
        'Channel 12 "Groceries"',
        '  address    telegram -1001234567890:42',
        '  agent      none',
        '  next turn  none: no one answers here',
        '  history    no messages yet',
        '  created    2026-09-28 14:00',
        '',
        'Warning: no one answers here: "Groceries" is claimed by a.md and b.md.',
      ].join('\n'),
    );
  });

  it('prints history with time, direction, and origin, indenting later lines', () => {
    expect(
      formatHistory(groceries, [
        message({
          origin: 'pero',
          direction: 'out',
          agent: null,
          senderId: null,
          text: 'Welcome',
        }),
        message({ id: 2, text: 'Milk\nand eggs' }),
        message({
          id: 3,
          direction: 'out',
          origin: 'agent',
          senderId: null,
          text: 'Noted',
        }),
        message({
          id: 4,
          direction: 'out',
          origin: 'workflow',
          agent: null,
          workflow: 'weekly-shop',
          senderId: null,
          text: 'Shop on Friday',
        }),
      ]),
    ).toBe(
      [
        '2026-09-28 15:04  out  pero                  Welcome',
        '2026-09-28 15:04  in   user                  Milk',
        '                                             and eggs',
        '2026-09-28 15:04  out  agent groceries       Noted',
        '2026-09-28 15:04  out  workflow weekly-shop  Shop on Friday',
      ].join('\n'),
    );
  });

  it('says when a Channel has no messages', () => {
    expect(formatHistory(groceries, [])).toBe(
      'No messages yet in Channel 12 (telegram -1001234567890:42 "Groceries").',
    );
  });
});
