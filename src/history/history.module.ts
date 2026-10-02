import { Module } from '@nestjs/common';
import { SystemModule } from '../system/system.module.js';
import { MessageHistory } from './message-history.service.js';

/** Each Channel's message history, shared by Channels and turns. */
@Module({
  imports: [SystemModule],
  providers: [MessageHistory],
  exports: [MessageHistory],
})
export class HistoryModule {}
