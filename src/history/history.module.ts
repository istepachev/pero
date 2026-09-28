import { Module } from '@nestjs/common';
import { MessageHistory } from './message-history.service.js';

/** Each Channel's message history, shared by Channels and Agents. */
@Module({
  providers: [MessageHistory],
  exports: [MessageHistory],
})
export class HistoryModule {}
