import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module.js';
import { MessageHistory } from './message-history.service.js';

/** Each Channel's message history, shared by Channels and Agents. */
@Module({
  imports: [SettingsModule],
  providers: [MessageHistory],
  exports: [MessageHistory],
})
export class HistoryModule {}
