import type { Chat, Message, Update, User } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import {
  GROUP_ANONYMOUS_BOT_ID,
  parseAddress,
  toInbound,
} from './telegram-updates.js';

const ME = { id: 7000001 };
// Beyond Number.MAX_SAFE_INTEGER is impossible for Telegram IDs, but they
// are long enough that Pero keeps them as strings throughout.
const FORUM: Chat.SupergroupChat = {
  id: -1001234567890,
  type: 'supergroup',
  title: 'Household',
  is_forum: true,
};
const PLAIN_GROUP: Chat.GroupChat = {
  id: -4567,
  type: 'group',
  title: 'Family',
};
const DIRECT: Chat.PrivateChat = {
  id: 1234,
  type: 'private',
  first_name: 'Ada',
  last_name: 'Lovelace',
};
const OWNER: User = { id: 1234, is_bot: false, first_name: 'Ada' };

let nextId = 100;

function update(message: Partial<Message> & { chat: Chat }): Update {
  return {
    update_id: nextId++,
    message: {
      message_id: nextId++,
      date: 0,
      from: OWNER,
      ...message,
    } as never,
  };
}

describe('toInbound', () => {
  it('scopes update IDs to the bot, so a new token never looks like redelivery', () => {
    const inbound = toInbound(
      { ...update({ chat: DIRECT, text: 'Hi' }), update_id: 55 },
      ME,
    );

    expect(inbound?.updateId).toBe('7000001:55');
  });

  describe('addresses', () => {
    it('keys a forum topic by chat and thread', () => {
      const inbound = toInbound(
        update({
          chat: FORUM,
          text: 'Hi',
          message_thread_id: 42,
          is_topic_message: true,
        }),
        ME,
      );

      expect(inbound).toMatchObject({
        integrationKind: 'telegram',
        chat: {
          key: '-1001234567890',
          kind: 'group',
          title: 'Household',
          address: { chatId: '-1001234567890' },
        },
        channel: {
          key: '-1001234567890:42',
          title: null,
          address: { chatId: '-1001234567890', messageThreadId: '42' },
          topicId: '42',
        },
        senderId: '1234',
        content: { text: 'Hi' },
      });
    });

    it("takes a topic's title from its creation when Telegram attaches it", () => {
      const inbound = toInbound(
        update({
          chat: FORUM,
          text: 'Hi',
          message_thread_id: 42,
          is_topic_message: true,
          reply_to_message: {
            message_id: 42,
            date: 0,
            chat: FORUM,
            forum_topic_created: { name: 'Health', icon_color: 0 },
          } as never,
        }),
        ME,
      );

      expect(inbound).toMatchObject({ channel: { title: 'Health' } });
    });

    it("gives the General topic the chat's own key", () => {
      const inbound = toInbound(update({ chat: FORUM, text: 'Hi' }), ME);

      expect(inbound).toMatchObject({
        channel: {
          key: '-1001234567890',
          title: 'Household',
          address: { chatId: '-1001234567890' },
          topicId: null,
        },
      });
    });

    it('ignores a reply thread in a group without topics', () => {
      const inbound = toInbound(
        update({ chat: PLAIN_GROUP, text: 'Re', message_thread_id: 9 }),
        ME,
      );

      expect(inbound).toMatchObject({
        chat: { key: '-4567', kind: 'group', title: 'Family' },
        channel: { key: '-4567', address: { chatId: '-4567' }, topicId: null },
      });
    });

    it('keys a direct chat by the user, titled with their name', () => {
      const inbound = toInbound(update({ chat: DIRECT, text: 'Hi' }), ME);

      expect(inbound).toMatchObject({
        chat: { key: '1234', kind: 'private', title: 'Ada Lovelace' },
        channel: { key: '1234', address: { chatId: '1234' }, topicId: null },
      });
    });

    it('ignores Telegram channels', () => {
      const channel: Chat.ChannelChat = {
        id: -1009,
        type: 'channel',
        title: 'News',
      };
      expect(toInbound(update({ chat: channel, text: 'Post' }), ME)).toBeNull();
    });
  });

  describe('messages', () => {
    it('uses a caption as the text', () => {
      const inbound = toInbound(
        update({ chat: DIRECT, caption: 'A photo of the receipt' }),
        ME,
      );

      expect(inbound).toMatchObject({
        content: { text: 'A photo of the receipt' },
      });
    });

    it('ignores a message without text', () => {
      expect(
        toInbound(
          update({ chat: DIRECT, sticker: {} as Message['sticker'] }),
          ME,
        ),
      ).toBeNull();
    });

    it('ignores other bots, which also stops loops', () => {
      const bot: User = { id: 999, is_bot: true, first_name: 'Other' };
      expect(
        toInbound(update({ chat: FORUM, from: bot, text: 'Beep' }), ME),
      ).toBeNull();
    });

    it('lets an anonymous administrator of the chat through as the chat', () => {
      const inbound = toInbound(
        update({
          chat: FORUM,
          from: {
            id: GROUP_ANONYMOUS_BOT_ID,
            is_bot: true,
            first_name: 'Group',
          },
          sender_chat: FORUM,
          text: 'Hi',
        }),
        ME,
      );

      expect(inbound).toMatchObject({ senderId: '-1001234567890' });
    });

    it("ignores a channel's post copied into its discussion group", () => {
      expect(
        toInbound(
          update({ chat: FORUM, is_automatic_forward: true, text: 'News' }),
          ME,
        ),
      ).toBeNull();
    });
  });

  describe('events', () => {
    it('maps a created topic', () => {
      const created = update({
        chat: FORUM,
        message_thread_id: 42,
        is_topic_message: true,
        forum_topic_created: { name: 'Health', icon_color: 0 },
      });
      // A topic's creation is the first message in it.
      created.message!.message_id = 42;

      expect(toInbound(created, ME)).toMatchObject({
        type: 'topic-created',
        chat: { key: '-1001234567890' },
        channel: {
          key: '-1001234567890:42',
          title: 'Health',
          address: { chatId: '-1001234567890', messageThreadId: '42' },
          topicId: '42',
        },
      });
    });

    it('maps a renamed topic, and ignores an icon change', () => {
      const renamed = toInbound(
        update({
          chat: FORUM,
          message_thread_id: 42,
          is_topic_message: true,
          forum_topic_edited: { name: 'Fitness' },
        }),
        ME,
      );
      const icon = toInbound(
        update({
          chat: FORUM,
          message_thread_id: 42,
          is_topic_message: true,
          forum_topic_edited: { icon_custom_emoji_id: '5' },
        }),
        ME,
      );

      expect(renamed).toMatchObject({
        type: 'topic-renamed',
        channel: { key: '-1001234567890:42', title: 'Fitness' },
      });
      expect(icon).toBeNull();
    });

    it('maps a migration seen in the old chat', () => {
      const inbound = toInbound(
        update({ chat: PLAIN_GROUP, migrate_to_chat_id: -1001234567890 }),
        ME,
      );

      expect(inbound).toMatchObject({
        type: 'chat-migrated',
        chat: { key: '-4567' },
        newChatKey: '-1001234567890',
        newAddress: { chatId: '-1001234567890' },
      });
    });

    it('maps a migration seen in the new chat to the same move', () => {
      const inbound = toInbound(
        update({ chat: FORUM, migrate_from_chat_id: -4567 }),
        ME,
      );

      expect(inbound).toMatchObject({
        type: 'chat-migrated',
        chat: { key: '-4567', kind: 'group', address: { chatId: '-4567' } },
        newChatKey: '-1001234567890',
        newAddress: { chatId: '-1001234567890' },
      });
    });

    it.each([
      ['creator', 'administrator'],
      ['administrator', 'administrator'],
      ['member', 'member'],
      ['left', 'left'],
      ['kicked', 'left'],
    ])("maps the bot's %s status to %s", (from, to) => {
      const inbound = toInbound(
        {
          update_id: nextId++,
          my_chat_member: {
            chat: FORUM,
            from: OWNER,
            date: 0,
            old_chat_member: { status: 'left', user: OWNER },
            new_chat_member: { status: from, user: OWNER } as never,
          },
        },
        ME,
      );

      expect(inbound).toMatchObject({
        type: 'membership-changed',
        chat: { key: '-1001234567890' },
        status: to,
      });
    });

    it('ignores other service messages', () => {
      expect(
        toInbound(update({ chat: FORUM, new_chat_members: [OWNER] }), ME),
      ).toBeNull();
    });
  });
});

describe('parseAddress', () => {
  it('reads a chat and a topic address', () => {
    expect(parseAddress({ chatId: '-100' })).toEqual({ chatId: '-100' });
    expect(parseAddress({ chatId: '-100', messageThreadId: '4' })).toEqual({
      chatId: '-100',
      messageThreadId: '4',
    });
  });

  it('refuses an address from another integration', () => {
    expect(() => parseAddress({ channel: 'C1' })).toThrow();
  });
});
