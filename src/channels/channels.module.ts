import { Module } from '@nestjs/common';
import { AllowedChatsService } from './allowed-chats.service.js';
import { ChannelRouter } from './channel-router.js';
import {
  ChannelOnboarding,
  ChannelTurns,
  UnwiredChannelOnboarding,
  UnwiredChannelTurns,
} from './channel-stages.js';
import { InboundUpdates } from './inbound-updates.service.js';
import { PairingRequests } from './pairing-requests.js';

/** The Channel router and the chat allowlist; adapters connect to it. */
@Module({
  providers: [
    ChannelRouter,
    AllowedChatsService,
    InboundUpdates,
    PairingRequests,
    { provide: ChannelTurns, useClass: UnwiredChannelTurns },
    { provide: ChannelOnboarding, useClass: UnwiredChannelOnboarding },
  ],
  exports: [ChannelRouter, AllowedChatsService, PairingRequests],
})
export class ChannelsModule {}
