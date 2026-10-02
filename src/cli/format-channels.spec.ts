import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ChannelDetails,
  ChannelNoteView,
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
  note: 'data/System/Channels/Default.md',
  unanswered: null,
  createdAt: '2026-09-28T09:00:00.000Z',
};

const groceries: ChannelView = {
  ...general,
  id: 12,
  key: '-1001234567890:42',
  title: 'Groceries',
  note: 'data/System/Channels/Groceries.md',
};

const settings: ChannelNoteView = {
  name: 'groceries',
  title: 'Groceries',
  file: 'data/System/Channels/Groceries.md',
  channelId: 'telegram:-1001234567890:42',
  provider: 'claude',
  model: 'sonnet',
  effort: null,
  workingDirectory: null,
  effectiveWorkingDirectory: '/home/me/workspace',
  instructions: 'Keep the list.',
  permissions: 'ask',
  skipGitRepoCheck: false,
  enabled: true,
  origins: {
    provider: 'default',
    model: 'note',
    effort: 'default',
    permissions: 'pero',
    workingDirectory: 'workspace',
  },
  errors: [],
};

const details: ChannelDetails = {
  ...groceries,
  settings,
  folderProblem: null,
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

  it('lists Channels with the note each is answered with, then unused notes', () => {
    expect(
      formatChannelList(
        [
          general,
          {
            ...groceries,
            unanswered: 'data/System/Channels/Groceries.md sets enabled: false',
            title: null,
          },
          {
            ...groceries,
            id: 13,
            key: '-1001234567890:43',
            title: 'Chores',
            note: null,
          },
        ],
        [
          { file: 'data/System/Channels/Garden.md', channelId: null },
          {
            file: 'data/System/Channels/Away.md',
            channelId: 'telegram:-100999:1',
          },
        ],
      ),
    ).toBe(
      [
        'ID  CHANNEL                     TITLE      NOTE',
        '1   telegram -1001234567890     Household  data/System/Channels/Default.md',
        '12  telegram -1001234567890:42  —          data/System/Channels/Groceries.md (not answering)',
        '13  telegram -1001234567890:43  Chores     none yet',
        '',
        'Channel notes no Channel Pero has seen uses yet:',
        '  NOTE                            CHANNEL-ID',
        '  data/System/Channels/Garden.md  (none: a topic of its title binds it)',
        '  data/System/Channels/Away.md    telegram:-100999:1',
      ].join('\n'),
    );
  });

  it('explains how Channels come to be when there is none', () => {
    expect(formatChannelList([])).toMatch(
      /^No Channels yet\. .*pero telegram allow/,
    );
  });

  it('shows a Channel with its settings, next turn, and history in local time', () => {
    expect(formatChannelDetails(details)).toBe(
      [
        'Channel 12 "Groceries"',
        '  address            telegram -1001234567890:42',
        '  note               data/System/Channels/Groceries.md',
        '  provider           claude (default)',
        '  model              sonnet',
        '  effort             (provider default)',
        '  working directory  /home/me/workspace (workspace)',
        '  instructions       Keep the list.',
        '  permissions        ask (Pero.md)',
        '  codex git check    required',
        '  state              enabled',
        '  next turn          resumes Session 3',
        '  history            4 messages, the latest at 2026-09-28 15:04',
        '  created            2026-09-28 14:00',
      ].join('\n'),
    );
  });

  it('says why Pero does not answer', () => {
    expect(
      formatChannelDetails({
        ...details,
        settings: null,
        unanswered: 'its note data/System/Channels/Groceries.md has errors',
        nextTurn: null,
        messages: 0,
        lastMessageAt: null,
      }),
    ).toBe(
      [
        'Channel 12 "Groceries"',
        '  address    telegram -1001234567890:42',
        '  note       data/System/Channels/Groceries.md',
        "  next turn  none: Pero doesn't answer here",
        '  history    no messages yet',
        '  created    2026-09-28 14:00',
        '',
        "Warning: Pero doesn't answer here: its note data/System/Channels/Groceries.md has errors.",
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
        '2026-09-28 15:04  out  answer groceries      Noted',
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
