import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { DefinitionsModule } from '../definitions/definitions.module.js';
import { HistoryModule } from '../history/history.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { AgentChannelTurns } from './agent-channel-turns.js';
import { AgentNamer, SlugAgentNamer } from './agent-namer.js';
import { AllowedChatsService } from './allowed-chats.service.js';
import { ChannelOnboardingService } from './channel-onboarding.service.js';
import { ChannelRouter } from './channel-router.js';
import { ChannelSender } from './channel-sender.js';
import { ChannelViews } from './channel-views.service.js';
import { ChannelOnboarding, ChannelTurns } from './channel-stages.js';
import { ChannelsService } from './channels.service.js';
import { InboundUpdates } from './inbound-updates.service.js';
import { PairingRequests } from './pairing-requests.js';
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  TOOL_APPROVAL_TIMEOUT_MS,
  ToolApprovals,
} from './tool-approvals.js';

/**
 * The Channel router, the chat allowlist, onboarding, the hand-off to
 * Agents, and Channel management; adapters connect to it.
 */
@Module({
  imports: [AgentsModule, DefinitionsModule, HistoryModule, SessionsModule],
  providers: [
    ChannelRouter,
    ChannelSender,
    ChannelViews,
    ChannelsService,
    AllowedChatsService,
    InboundUpdates,
    PairingRequests,
    ToolApprovals,
    {
      provide: TOOL_APPROVAL_TIMEOUT_MS,
      useValue: DEFAULT_APPROVAL_TIMEOUT_MS,
    },
    { provide: ChannelTurns, useClass: AgentChannelTurns },
    { provide: ChannelOnboarding, useClass: ChannelOnboardingService },
    { provide: AgentNamer, useClass: SlugAgentNamer },
  ],
  exports: [
    ChannelRouter,
    ChannelSender,
    ChannelViews,
    ChannelsService,
    AllowedChatsService,
    PairingRequests,
  ],
})
export class ChannelsModule {}
