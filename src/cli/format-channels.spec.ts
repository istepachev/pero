import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ChannelDetails,
  ChannelView,
  HistoryMessage,
} from '../control/protocol.js';
import {
  formatAssigned,
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
  agentDefined: true,
  enabled: true,
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

  it('lists Channels with their Agent and state', () => {
    expect(
      formatChannelList([
        general,
        { ...groceries, agentEnabled: false, enabled: false, title: null },
      ]),
    ).toBe(
      [
        'ID  CHANNEL                     TITLE      AGENT                 STATE',
        '1   telegram -1001234567890     Household  main                  enabled',
        '12  telegram -1001234567890:42  —          groceries (disabled)  disabled',
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
        '  state      enabled',
        '  next turn  resumes Session 3',
        '  history    4 messages, the latest at 2026-09-28 15:04',
        '  created    2026-09-28 14:00',
      ].join('\n'),
    );
  });

  it('warns when the Agent is disabled', () => {
    expect(
      formatChannelDetails({
        ...details,
        agentEnabled: false,
        agentDefined: true,
        messages: 0,
        lastMessageAt: null,
      }),
    ).toMatch(
      /history {4}no messages yet\n.*\n\nWarning: Agent groceries is disabled, so this Channel gets no answer until it is enabled again \(enabled: true in its note\)\.$/,
    );
  });

  it('says what an assignment does to the next turn', () => {
    const assigned: ChannelDetails = {
      ...details,
      agent: 'chef',
      nextTurn: {
        kind: 'new',
        reason: null,
        from: null,
        sessionId: null,
        carriesOver: true,
      },
    };
    expect(formatAssigned(assigned, false)).toBe(
      'Channel 12 (telegram -1001234567890:42 "Groceries") now talks to Agent chef.\n' +
        "Its next turn starts a fresh Session, with the Channel's recent messages.",
    );
    expect(
      formatAssigned(
        {
          ...assigned,
          enabled: false,
          nextTurn: { ...assigned.nextTurn!, carriesOver: false },
        },
        false,
      ),
    ).toBe(
      'Channel 12 (telegram -1001234567890:42 "Groceries") now talks to Agent chef.\n' +
        'Its next turn starts a fresh Session.\n' +
        'It is disabled, so it gets no answer until pero channels enable 12.',
    );
    expect(formatAssigned(details, true)).toBe(
      'Channel 12 (telegram -1001234567890:42 "Groceries") already talks to Agent groceries.',
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
