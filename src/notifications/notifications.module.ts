import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module.js';
import { HistoryModule } from '../history/history.module.js';
import { NotificationDelivery } from './notification-delivery.js';

/**
 * Delivers Workflow Notifications to their Channels. The delivery tick
 * runs only where `ScheduleModule.forRoot()` is imported, which is the
 * daemon's AppModule.
 */
@Module({
  imports: [ChannelsModule, HistoryModule],
  providers: [NotificationDelivery],
  exports: [NotificationDelivery],
})
export class NotificationsModule {}
