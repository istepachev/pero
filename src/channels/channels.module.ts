import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { HistoryModule } from '../history/history.module.js';
import { AgentChannelTurns } from './agent-channel-turns.js';
import { AgentNamer, SlugAgentNamer } from './agent-namer.js';
import { AllowedChatsService } from './allowed-chats.service.js';
import { ChannelOnboardingService } from './channel-onboarding.service.js';
import { ChannelRouter } from './channel-router.js';
import { ChannelSender } from './channel-sender.js';
import { ChannelOnboarding, ChannelTurns } from './channel-stages.js';
import { InboundUpdates } from './inbound-updates.service.js';
import { PairingRequests } from './pairing-requests.js';

/**
 * The Channel router, the chat allowlist, onboarding, and the hand-off to
 * Agents; adapters connect to it.
 */
@Module({
  imports: [AgentsModule, HistoryModule],
  providers: [
    ChannelRouter,
    ChannelSender,
    AllowedChatsService,
    InboundUpdates,
    PairingRequests,
    { provide: ChannelTurns, useClass: AgentChannelTurns },
    { provide: ChannelOnboarding, useClass: ChannelOnboardingService },
    { provide: AgentNamer, useClass: SlugAgentNamer },
  ],
  exports: [ChannelRouter, ChannelSender, AllowedChatsService, PairingRequests],
})
export class ChannelsModule {}
