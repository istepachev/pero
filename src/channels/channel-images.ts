import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { IMAGE_TYPES } from '../common/images.js';
import { workspaceLayout } from '../config/workspace-layout.js';
import type { Channel } from '../persistence/entities/channel.entity.js';
import { SystemNotes } from '../system/system-notes.service.js';
import type { InboundImage } from './channel-adapter.js';
import { ChannelSender } from './channel-sender.js';

/**
 * Keeps the images people send: each is downloaded through its adapter and
 * saved, owner-only, under `.pero/attachments/<Channel ID>/`, where turns
 * read it.
 */
@Injectable()
export class ChannelImages {
  constructor(
    private readonly sender: ChannelSender,
    private readonly notes: SystemNotes,
  ) {}

  /**
   * Downloads `images`, which message `messageId` in `channel` came with,
   * and resolves to the absolute paths they are saved at, in order. Throws
   * when one can't be downloaded or saved.
   */
  async save(
    channel: Pick<Channel, 'id' | 'integrationKind'>,
    messageId: string,
    images: readonly InboundImage[],
    now: Date = new Date(),
  ): Promise<string[]> {
    const folder = join(
      workspaceLayout(this.notes.folders().workspace).attachments,
      String(channel.id),
    );
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const paths: string[] = [];
    for (const [index, image] of images.entries()) {
      const data = await this.sender.download(
        channel.integrationKind,
        image.ref,
      );
      // The integration's message ID, kept to what a file name may hold.
      const id = messageId.replace(/[^\w-]/g, '_');
      const name = `${fileStamp(now)}-${id}-${index + 1}.${IMAGE_TYPES[image.type]}`;
      const path = join(folder, name);
      await writeFile(path, data, { mode: 0o600 });
      paths.push(path);
    }
    return paths;
  }
}

/** `20261003-061700` in UTC, so saved images sort by when they came. */
function fileStamp(date: Date): string {
  return date
    .toISOString()
    .slice(0, 19)
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace('T', '-');
}

/**
 * The line a message's text gets for each image it came with, so that its
 * turn, and later ones reading the history, know where the image is.
 */
export function imageLine(path: string): string {
  return `[Image attached, saved at ${path}]`;
}

/** `text` with a line for each image at `paths` before it. */
export function withImageLines(text: string, paths: readonly string[]): string {
  return [...paths.map(imageLine), ...(text === '' ? [] : [text])].join('\n');
}
