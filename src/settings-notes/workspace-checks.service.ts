import { homedir } from 'node:os';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { InvalidInputError } from '../common/errors.js';
import { HostConfigService } from '../host-config/host-config.service.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import {
  checkWorkspace,
  type WorkspaceCheck,
} from '../settings-files/check.js';
import { channelTopicLookup } from './channel-topics.js';

/**
 * `pero check` with Pero running: the same checks as without it, of the
 * files as they are on disk now, plus Workflow topic titles checked
 * against the topics Pero has seen in the allowed chats.
 */
@Injectable()
export class WorkspaceChecks {
  constructor(
    private readonly hostConfig: HostConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async check(): Promise<WorkspaceCheck> {
    const folders = this.hostConfig.folders();
    if (folders === null) {
      throw new InvalidInputError(
        'This Pero runs from a legacy data directory: its Agents and Workflows are in its database, and there are no notes to check',
      );
    }
    const allowed = new Set(
      this.hostConfig.allowedChats().map((chat) => chat.chatKey),
    );
    const channels = await this.dataSource.getRepository(Channel).find({
      select: { id: true, externalKey: true, title: true },
      where: { integrationKind: 'telegram' },
      order: { id: 'ASC' },
    });
    return checkWorkspace({
      workspace: folders.workspace,
      homeDir: homedir(),
      hostTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      topics: channelTopicLookup(
        channels
          .filter((channel) => allowed.has(channel.externalKey.split(':')[0]!))
          .map(({ id, externalKey, title }) => ({
            id,
            key: externalKey,
            title,
          })),
      ),
    });
  }
}
