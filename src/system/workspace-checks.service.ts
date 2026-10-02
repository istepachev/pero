import { homedir } from 'node:os';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { HostConfigService } from '../host-config/host-config.service.js';
import { checkWorkspace, type WorkspaceCheck } from '../system-files/check.js';
import { allowedChannels } from './allowed-channels.js';
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
    return checkWorkspace({
      workspace: this.hostConfig.folders().workspace,
      homeDir: homedir(),
      hostTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      topics: channelTopicLookup(
        await allowedChannels(this.dataSource, this.hostConfig.allowedChats()),
      ),
    });
  }
}
