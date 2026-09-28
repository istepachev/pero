import { Injectable } from '@nestjs/common';
import { slugify } from '../config/slug.js';
import type { InboundChannel } from './channel-adapter.js';

/**
 * Names the Agent onboarding creates for a new topic. An abstract class so
 * it can serve as its own injection token.
 */
export abstract class AgentNamer {
  /**
   * A slug for `channel`'s Agent. Onboarding makes it unique, so it need
   * not be. A namer that asks a model must fall back to `SlugAgentNamer`'s
   * name when the model fails or answers with anything but a slug.
   */
  abstract suggest(channel: InboundChannel): Promise<string>;
}

/** The topic title as a slug, or `topic-<id>` when nothing of it is left. */
@Injectable()
export class SlugAgentNamer extends AgentNamer {
  suggest(channel: InboundChannel): Promise<string> {
    return Promise.resolve(
      slugify(channel.title ?? '') ??
        slugify(`topic-${channel.topicId ?? ''}`) ??
        'topic',
    );
  }
}
