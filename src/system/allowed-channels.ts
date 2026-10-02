import type { DataSource } from 'typeorm';
import { Channel } from '../persistence/entities/channel.entity.js';
import type { KnownChannel } from './channel-topics.js';

/**
 * The Telegram Channels Pero has seen in the chats `allowed` lists, by
 * chat key, oldest first: what Workflow references can name.
 */
export async function allowedChannels(
  dataSource: DataSource,
  allowed: readonly { chatKey: string }[],
): Promise<KnownChannel[]> {
  const chats = new Set(allowed.map((chat) => chat.chatKey));
  const channels = await dataSource.getRepository(Channel).find({
    select: { id: true, integrationKind: true, externalKey: true, title: true },
    where: { integrationKind: 'telegram' },
    order: { id: 'ASC' },
  });
  return channels
    .filter((channel) => chats.has(channel.externalKey.split(':')[0]!))
    .map(({ id, integrationKind, externalKey, title }) => ({
      id,
      kind: integrationKind,
      key: externalKey,
      title,
    }));
}
