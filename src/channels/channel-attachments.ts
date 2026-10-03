import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { IMAGE_TYPES, isImageType } from '../common/images.js';
import { workspaceLayout } from '../config/workspace-layout.js';
import type { Channel } from '../persistence/entities/channel.entity.js';
import { SystemNotes } from '../system/system-notes.service.js';
import type { InboundAttachment } from './channel-adapter.js';
import { ChannelSender } from './channel-sender.js';

/** The longest file name a saved file keeps from the one it was sent with. */
const MAX_NAME_LENGTH = 80;

/** A file a message came with, saved where turns read it. */
export interface SavedAttachment {
  /** Its absolute path. */
  path: string;
  /** Its file name as sent; null for a photo or when there was none. */
  name: string | null;
  /** Whether it is an image of a type in `IMAGE_TYPES`. */
  image: boolean;
}

/**
 * Keeps the files people send, images and others: each is downloaded
 * through its adapter and saved, owner-only, under
 * `.pero/attachments/<Channel ID>/`, where turns read it.
 */
@Injectable()
export class ChannelAttachments {
  constructor(
    private readonly sender: ChannelSender,
    private readonly notes: SystemNotes,
  ) {}

  /**
   * Downloads `attachments`, which message `messageId` in `channel` came
   * with, and resolves to where they are saved, in order. Throws when one
   * can't be downloaded or saved.
   */
  async save(
    channel: Pick<Channel, 'id' | 'integrationKind'>,
    messageId: string,
    attachments: readonly InboundAttachment[],
    now: Date = new Date(),
  ): Promise<SavedAttachment[]> {
    const folder = join(
      workspaceLayout(this.notes.folders().workspace).attachments,
      String(channel.id),
    );
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const saved: SavedAttachment[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const data = await this.sender.download(
        channel.integrationKind,
        attachment.ref,
      );
      // The integration's message ID, kept to what a file name may hold.
      const id = messageId.replace(/[^\w-]/g, '_');
      const prefix = `${fileStamp(now)}-${id}-${index + 1}`;
      const { type } = attachment;
      const image = isImageType(type);
      const name = image
        ? `${prefix}.${IMAGE_TYPES[type]}`
        : `${prefix}-${withPdfExtension(safeName(attachment.name), type)}`;
      const path = join(folder, name);
      await writeFile(path, data, { mode: 0o600 });
      saved.push({ path, name: attachment.name, image });
    }
    return saved;
  }
}

/** `20261003-061700` in UTC, so saved files sort by when they came. */
function fileStamp(date: Date): string {
  return date
    .toISOString()
    .slice(0, 19)
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace('T', '-');
}

/**
 * `name`, a file's name as sent, kept to what a file name may safely hold
 * and to `MAX_NAME_LENGTH`, its extension last; `file` when nothing is
 * left of it.
 */
export function safeName(name: string | null): string {
  const cleaned = (name ?? '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[._]+/, '')
    .replace(/_+$/, '');
  if (cleaned === '') return 'file';
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  const extension = extname(cleaned).slice(0, 16);
  return cleaned.slice(0, MAX_NAME_LENGTH - extension.length) + extension;
}

/**
 * `name`, ending in `.pdf` when `type` says it is a PDF, since that is how
 * a turn tells one.
 */
function withPdfExtension(name: string, type: string): string {
  return type === 'application/pdf' && extname(name).toLowerCase() !== '.pdf'
    ? `${name}.pdf`
    : name;
}

/**
 * The line a message's text gets for each file it came with, so that its
 * turn, and later ones reading the history, know where the file is.
 */
export function attachmentLine(attachment: SavedAttachment): string {
  if (attachment.image) return `[Image attached, saved at ${attachment.path}]`;
  const name = attachment.name === null ? '' : `: ${attachment.name}`;
  return `[File attached${name}, saved at ${attachment.path}]`;
}

/** `text` with a line for each of `attachments` before it. */
export function withAttachmentLines(
  text: string,
  attachments: readonly SavedAttachment[],
): string {
  return [
    ...attachments.map(attachmentLine),
    ...(text === '' ? [] : [text]),
  ].join('\n');
}
