import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module.js';
import { DefinitionsModule } from '../definitions/definitions.module.js';
import { HealthModule } from '../health/health.module.js';
import { HistoryModule } from '../history/history.module.js';
import { NotificationDelivery } from './notification-delivery.js';
import { NotificationViews } from './notification-views.service.js';

/**
 * Delivers Workflow Notifications to their Channels, and shows them. The delivery tick
 * runs only where `ScheduleModule.forRoot()` is imported, which is the
 * daemon's AppModule.
 */
@Module({
  imports: [ChannelsModule, DefinitionsModule, HealthModule, HistoryModule],
  providers: [NotificationDelivery, NotificationViews],
  exports: [NotificationDelivery, NotificationViews],
})
export class NotificationsModule {}
