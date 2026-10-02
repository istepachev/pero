import type { ChannelRef } from '../system-files/schemas.js';
import {
  GENERAL_TOPIC,
  type ResolvedChannel,
  type TopicLookup,
  type TopicResolution,
} from '../system-files/snapshot.js';

/** A Channel Pero has seen, as the `channels` table keeps it. */
export interface KnownChannel {
  id: number;
  /** `<chat_id>` for a chat's primary Channel, `<chat_id>:<topic_id>` for a topic. */
  key: string;
  /** The topic's title, or the chat's for a primary Channel. */
  title: string | null;
}

interface Entry {
  channel: ResolvedChannel;
  /** The title a reference matches: the topic's, or `General` in a group. */
  title: string | null;
  chatTitle: string;
}

/**
 * Finds the Channels Workflow references name among `channels`: a topic
 * by its title, a group's General topic as `General`, either one within a
 * chat as `<chat title>/<topic title>`, and any Channel by its ID. Titles
 * match ignoring case.
 */
export function channelTopicLookup(
  channels: readonly KnownChannel[],
): TopicLookup {
  const chatTitles = new Map(
    channels
      .filter((channel) => !channel.key.includes(':'))
      .map((channel) => [channel.key, channel.title]),
  );
  const entries: Entry[] = channels.map((channel) => {
    const [chatKey] = channel.key.split(':') as [string];
    const topic = channel.key.includes(':');
    const group = chatKey.startsWith('-');
    return {
      channel: {
        id: channel.id,
        primary: !topic,
        title: topic ? (channel.title ?? '') : GENERAL_TOPIC,
      },
      // A direct chat has no topic title to name it by; its ID does.
      title: topic ? channel.title : group ? GENERAL_TOPIC : null,
      chatTitle: chatTitles.get(chatKey) ?? chatKey,
    };
  });
  const seen = [
    ...new Set(
      entries.flatMap((entry) => (entry.title === null ? [] : [entry.title])),
    ),
  ];
  const titled = (title: string) =>
    entries.filter(
      (entry) => entry.title?.toLowerCase() === title.trim().toLowerCase(),
    );

  return {
    resolve(ref: ChannelRef): TopicResolution {
      let matches: Entry[];
      if (typeof ref === 'number') {
        matches = entries.filter((entry) => entry.channel.id === ref);
      } else {
        matches = titled(ref);
        const slash = ref.indexOf('/');
        if (matches.length === 0 && slash !== -1) {
          const chat = ref.slice(0, slash).trim().toLowerCase();
          matches = titled(ref.slice(slash + 1)).filter(
            (entry) => entry.chatTitle.toLowerCase() === chat,
          );
        }
      }
      if (matches.length === 1)
        return { kind: 'ok', channel: matches[0]!.channel };
      if (matches.length === 0) return { kind: 'none', seen };
      return {
        kind: 'ambiguous',
        matches: matches.map((entry) => `${entry.chatTitle}/${entry.title}`),
      };
    },
  };
}
