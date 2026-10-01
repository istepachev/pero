import { describe, expect, it } from 'vitest';
import { channelTopicLookup, type KnownChannel } from './channel-topics.js';

const HOME = '-1001';
const WORK = '-1002';

const CHANNELS: KnownChannel[] = [
  { id: 1, key: HOME, title: 'Home' },
  { id: 2, key: `${HOME}:10`, title: 'Health' },
  { id: 3, key: `${HOME}:11`, title: 'English' },
  { id: 4, key: WORK, title: 'Work' },
  { id: 5, key: `${WORK}:20`, title: 'English' },
  { id: 6, key: '123456789', title: 'Ada Lovelace' },
  { id: 7, key: `${HOME}:12`, title: null },
];

describe('channelTopicLookup', () => {
  const lookup = channelTopicLookup(CHANNELS);

  it('finds a topic by its title, ignoring case', () => {
    for (const ref of ['Health', 'health', ' HEALTH ']) {
      expect(lookup.resolve(ref)).toEqual({
        kind: 'ok',
        channel: { id: 2, primary: false, title: 'Health' },
      });
    }
  });

  it('finds a Channel by its ID, a direct chat too', () => {
    expect(lookup.resolve(3)).toEqual({
      kind: 'ok',
      channel: { id: 3, primary: false, title: 'English' },
    });
    expect(lookup.resolve(6)).toEqual({
      kind: 'ok',
      channel: { id: 6, primary: true, title: 'General' },
    });
  });

  it('asks for the chat when several topics share a title', () => {
    expect(lookup.resolve('English')).toEqual({
      kind: 'ambiguous',
      matches: ['Home/English', 'Work/English'],
    });
    expect(lookup.resolve('work/english')).toEqual({
      kind: 'ok',
      channel: { id: 5, primary: false, title: 'English' },
    });
  });

  it("means a group's General topic by General", () => {
    expect(lookup.resolve('General')).toEqual({
      kind: 'ambiguous',
      matches: ['Home/General', 'Work/General'],
    });
    expect(lookup.resolve('Home/General')).toEqual({
      kind: 'ok',
      channel: { id: 1, primary: true, title: 'General' },
    });
  });

  it('lists the topics seen when nothing matches', () => {
    const none = {
      kind: 'none',
      seen: ['General', 'Health', 'English'],
    };
    expect(lookup.resolve('Helth')).toEqual(none);
    expect(lookup.resolve('Ada Lovelace')).toEqual(none);
    expect(lookup.resolve('Home/Running')).toEqual(none);
    expect(lookup.resolve(99)).toEqual(none);
  });

  it('names a chat by its ID when Pero has not seen its title', () => {
    expect(
      channelTopicLookup([
        { id: 1, key: `${HOME}:10`, title: 'Health' },
        { id: 2, key: `${WORK}:20`, title: 'Health' },
      ]).resolve('Health'),
    ).toEqual({
      kind: 'ambiguous',
      matches: [`${HOME}/Health`, `${WORK}/Health`],
    });
  });

  it('has seen nothing without Channels', () => {
    expect(channelTopicLookup([]).resolve('Health')).toEqual({
      kind: 'none',
      seen: [],
    });
  });
});
