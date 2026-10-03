import { slugify } from '../config/slug.js';
import type { IntegrationKind } from '../persistence/entities/sql.js';
import type { ChannelRef } from '../system-files/schemas.js';
import {
  channelIdFor,
  GENERAL_TOPIC,
  type ResolvedChannel,
  type TopicLookup,
  type TopicResolution,
} from '../system-files/snapshot.js';

/** A Channel Pero has seen, as the `channels` table keeps it. */
export interface KnownChannel {
  id: number;
  kind: IntegrationKind;
  /** `<chat_id>` for a chat's primary Channel, `<chat_id>:<topic_id>` for a topic. */
  key: string;
  /** The topic's title, or the chat's for a primary Channel. */
  title: string | null;
}

interface Entry {
  channel: ResolvedChannel;
  /** Whether it is a group's General topic, which `General` names. */
  general: boolean;
  chatTitle: string;
}

/**
 * Finds the Channels Workflow references name among `channels`: a group's
 * General topic as `General` or `<chat title>/General`, ignoring case, any
 * Channel by its ID, the Channel a note's `channel-id` names, and the
 * topics a note without one would be bound to, by their title.
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
    return {
      channel: {
        id: channel.id,
        channelId: channelIdFor(channel.kind, channel.key),
        primary: !topic,
        title: topic ? (channel.title ?? '') : GENERAL_TOPIC,
      },
      // A direct chat has no General topic to name it by; its ID does.
      general: !topic && chatKey.startsWith('-'),
      chatTitle: chatTitles.get(chatKey) ?? chatKey,
    };
  });
  const byChannelId = new Map(
    entries.map((entry) => [entry.channel.channelId, entry.channel]),
  );

  return {
    resolve(ref: ChannelRef): TopicResolution {
      let matches: Entry[];
      if (typeof ref === 'number') {
        matches = entries.filter((entry) => entry.channel.id === ref);
      } else {
        matches = entries.filter((entry) => entry.general);
        const slash = ref.lastIndexOf('/');
        if (slash !== -1) {
          const chat = ref.slice(0, slash).trim().toLowerCase();
          matches = matches.filter(
            (entry) => entry.chatTitle.toLowerCase() === chat,
          );
        }
      }
      if (matches.length === 1) {
        return { kind: 'ok', channel: matches[0]!.channel };
      }
      if (matches.length === 0) return { kind: 'none' };
      return {
        kind: 'ambiguous',
        matches: matches.map((entry) => `${entry.chatTitle}/${GENERAL_TOPIC}`),
      };
    },
    byChannelId(channelId: string): ResolvedChannel | null {
      return byChannelId.get(channelId) ?? null;
    },
    topicsNamed(name: string): ResolvedChannel[] {
      return entries
        .filter(
          ({ channel }) => !channel.primary && slugify(channel.title) === name,
        )
        .map(({ channel }) => channel);
    },
    primaryChannels(): ResolvedChannel[] {
      return entries
        .filter(({ channel }) => channel.primary)
        .map(({ channel }) => channel);
    },
  };
}
