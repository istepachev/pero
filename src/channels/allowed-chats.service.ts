import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { AllowedChat } from '../persistence/entities/allowed-chat.entity.js';
import type { ChatKind, IntegrationKind } from '../persistence/entities/sql.js';
import { inTransaction } from '../persistence/transaction.js';

export interface ChatToAllow {
  integrationKind: IntegrationKind;
  chatKey: string;
  kind: ChatKind;
  title: string | null;
}

/** The chats Pero serves; only the owner on the host adds to them. */
@Injectable()
export class AllowedChatsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  find(
    integrationKind: IntegrationKind,
    chatKey: string,
  ): Promise<AllowedChat | null> {
    return this.dataSource
      .getRepository(AllowedChat)
      .findOneBy({ integrationKind, chatKey });
  }

  /** The integration's allowed chats, oldest first. */
  list(integrationKind: IntegrationKind): Promise<AllowedChat[]> {
    return this.dataSource
      .getRepository(AllowedChat)
      .find({ where: { integrationKind }, order: { id: 'ASC' } });
  }

  /** Allows a chat; allowing one again updates its kind and title. */
  allow(chat: ChatToAllow): Promise<AllowedChat> {
    return inTransaction(this.dataSource, async (manager) => {
      const repo = manager.getRepository(AllowedChat);
      const { integrationKind, chatKey } = chat;
      const existing = await repo.findOneBy({ integrationKind, chatKey });
      if (existing === null) {
        await repo.insert(chat);
      } else {
        await repo.update(existing.id, { kind: chat.kind, title: chat.title });
      }
      return repo.findOneByOrFail({ integrationKind, chatKey });
    });
  }

  /** Records the chat's current name when it differs from the stored one. */
  async refreshTitle(chat: AllowedChat, title: string | null): Promise<void> {
    if (title === null || title === chat.title) return;
    await inTransaction(this.dataSource, (manager) =>
      manager.getRepository(AllowedChat).update(chat.id, { title }),
    );
  }
}
