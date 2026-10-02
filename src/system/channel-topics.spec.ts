import { describe, expect, it } from 'vitest';
import { channelTopicLookup, type KnownChannel } from './channel-topics.js';

const HOME = '-1001';
const WORK = '-1002';

const channel = (id: number, key: string, title: string | null) =>
  ({ id, kind: 'telegram', key, title }) satisfies KnownChannel;

const CHANNELS: KnownChannel[] = [
  channel(1, HOME, 'Home'),
  channel(2, `${HOME}:10`, 'Health'),
  channel(4, WORK, 'Work'),
  channel(5, `${WORK}:20`, 'English'),
  channel(6, '123456789', 'Ada Lovelace'),
];

describe('channelTopicLookup', () => {
  const lookup = channelTopicLookup(CHANNELS);

  it('finds a Channel by its ID, a direct chat too', () => {
    expect(lookup.resolve(2)).toEqual({
      kind: 'ok',
      channel: {
        id: 2,
        channelId: `telegram:${HOME}:10`,
        primary: false,
        title: 'Health',
      },
    });
    expect(lookup.resolve(6)).toEqual({
      kind: 'ok',
      channel: {
        id: 6,
        channelId: 'telegram:123456789',
        primary: true,
        title: 'General',
      },
    });
    expect(lookup.resolve(99)).toEqual({ kind: 'none' });
  });

  it("means a group's General topic by General, ignoring case", () => {
    expect(lookup.resolve('General')).toEqual({
      kind: 'ambiguous',
      matches: ['Home/General', 'Work/General'],
    });
    expect(lookup.resolve('home/general')).toEqual({
      kind: 'ok',
      channel: {
        id: 1,
        channelId: `telegram:${HOME}`,
        primary: true,
        title: 'General',
      },
    });
    expect(lookup.resolve('Away/General')).toEqual({ kind: 'none' });
    expect(channelTopicLookup([]).resolve('General')).toEqual({
      kind: 'none',
    });
  });

  it('finds the Channel a note’s channel-id names', () => {
    expect(lookup.byChannelId(`telegram:${WORK}:20`)).toMatchObject({
      id: 5,
      title: 'English',
    });
    expect(lookup.byChannelId(`telegram:${WORK}:21`)).toBeNull();
  });

  it('finds the topics a note’s name is the title of', () => {
    expect(lookup.topicsNamed('english')).toEqual([
      expect.objectContaining({ id: 5 }),
    ]);
    // A primary Channel is no topic.
    expect(lookup.topicsNamed('home')).toEqual([]);
  });
});
