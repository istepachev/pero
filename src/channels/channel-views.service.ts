import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { NotFoundError } from '../common/errors.js';
import { join } from 'node:path';
import type {
  ChannelDetails,
  ChannelView,
  HistoryMessage,
  UnusedNoteView,
} from '../control/protocol.js';
import {
  MessageHistory,
  workflowOf,
} from '../history/message-history.service.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Session } from '../persistence/entities/session.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import { nextTurn } from '../sessions/next-turn.js';
import { shownPath } from '../system-files/note-paths.js';
import {
  channelIdFor,
  DEFAULT_NOTE,
} from '../system-files/snapshot.js';
import { Definitions, type Route } from '../system/definitions.js';
import { SystemNotes } from '../system/system-notes.service.js';
import { channelNoteView, folderProblem } from './channel-note-view.js';
import { routeOf, unansweredSummary } from './channel-stages.js';

/**
 * Channels as the CLI shows them: the note Pero answers there with now,
 * what the next turn there does with its Session, and their message
 * history.
 */
@Injectable()
export class ChannelViews {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly messages: MessageHistory,
    private readonly definitions: Definitions,
    private readonly notes: SystemNotes,
  ) {}

  /** Every Channel, by ID, and the Channel notes none of them uses. */
  async list(): Promise<{
    channels: ChannelView[];
    unusedNotes: UnusedNoteView[];
  }> {
    const channels = await this.dataSource
      .getRepository(Channel)
      .find({ order: { id: 'ASC' } });
    const routes = channels.map((channel) =>
      routeOf(channel, this.definitions),
    );
    const used = new Set(
      routes.flatMap((route) =>
        route.kind === 'answered' && route.note.file !== null
          ? [route.note.file]
          : [],
      ),
    );
    const known = new Set(
      channels.map((channel) =>
        channelIdFor(channel.integrationKind, channel.externalKey),
      ),
    );
    const { workspace, systemFolder } = this.notes.folders();
    const unusedNotes = this.definitions
      .channelNotes()
      .filter(
        (note) =>
          note.name !== DEFAULT_NOTE &&
          note.file !== null &&
          !used.has(note.file) &&
          (note.channelId === null || !known.has(note.channelId)),
      )
      .map((note) => ({
        file: shownPath(workspace, join(systemFolder, note.file!)),
        channelId: note.channelId,
      }));
    return {
      channels: channels.map((channel, index) =>
        this.channelView(channel, routes[index]!),
      ),
      unusedNotes,
    };
  }

  /** The Channel with ID `id`; `NotFoundError` if none. */
  async details(id: number): Promise<ChannelDetails> {
    const { historyCarryover } = this.definitions.defaults();
    return inTransaction(this.dataSource, async (manager) => {
      const channel = await findChannel(manager, id);
      const route = routeOf(channel, this.definitions);
      const note = route.kind === 'answered' ? route.note : null;
      const active =
        note === null
          ? null
          : await manager.getRepository(Session).findOne({
              where: { channelId: id, status: 'active' },
              order: { id: 'DESC' },
            });
      const withHistory = await this.messages.channelsWithHistoryWithin(
        manager,
        [id],
      );
      const { count, lastAt } = await this.messages.statsWithin(manager, id);
      return {
        ...this.channelView(channel, route),
        settings:
          note === null
            ? null
            : channelNoteView(note, this.notes.snapshot(), this.notes.folders()),
        folderProblem:
          note === null ? null : await folderProblem(note.workingDirectory),
        nextTurn:
          note === null
            ? null
            : nextTurn(active, note, {
                hasHistory: withHistory.has(id),
                carryover: historyCarryover,
              }),
        messages: count,
        lastMessageAt: lastAt?.toISOString() ?? null,
      };
    });
  }

  /** The Channel and its latest `limit` messages, oldest first. */
  history(
    id: number,
    limit: number,
  ): Promise<{ channel: ChannelView; messages: HistoryMessage[] }> {
    return inTransaction(this.dataSource, async (manager) => {
      const channel = await findChannel(manager, id);
      const route = routeOf(channel, this.definitions);
      const messages = await this.messages.latestWithin(manager, id, limit);
      return {
        channel: this.channelView(channel, route),
        messages: messages.map((message) => ({
          id: message.id,
          createdAt: message.createdAt.toISOString(),
          direction: message.direction,
          origin: message.origin,
          agent: message.agentName,
          workflow: workflowOf(message),
          senderId: message.senderId,
          text: message.text,
        })),
      };
    });
  }

  private channelView(
    channel: Pick<
      Channel,
      'id' | 'integrationKind' | 'externalKey' | 'title' | 'createdAt'
    >,
    route: Route,
  ): ChannelView {
    const { workspace, systemFolder } = this.notes.folders();
    const file =
      route.kind === 'answered'
        ? route.note.file
        : route.reason.kind === 'disabled'
          ? route.reason.file
          : null;
    return {
      id: channel.id,
      integrationKind: channel.integrationKind,
      key: channel.externalKey,
      title: channel.title,
      note:
        file === null
          ? null
          : route.kind === 'answered'
            ? shownPath(workspace, join(systemFolder, file))
            : file,
      unanswered:
        route.kind === 'answered' ? null : unansweredSummary(route.reason),
      createdAt: channel.createdAt.toISOString(),
    };
  }
}

/** The Channel with ID `id`; `NotFoundError` if none. */
export async function findChannel(
  manager: EntityManager,
  id: number,
): Promise<Channel> {
  const channel = await manager.getRepository(Channel).findOneBy({ id });
  if (channel === null) throw new NotFoundError(`No Channel with ID ${id}`);
  return channel;
}
