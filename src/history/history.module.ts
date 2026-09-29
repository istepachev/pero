import { Module } from '@nestjs/common';
import { DefinitionsModule } from '../definitions/definitions.module.js';
import { MessageHistory } from './message-history.service.js';

/** Each Channel's message history, shared by Channels and Agents. */
@Module({
  imports: [DefinitionsModule],
  providers: [MessageHistory],
  exports: [MessageHistory],
})
export class HistoryModule {}
