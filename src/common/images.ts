import { extname } from 'node:path';

// Shared by the channels and the runtimes. Keep this free of Nest imports.

/**
 * The image types Pero accepts from a chat, which every provider reads,
 * with the extension a saved one gets.
 */
export const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
} as const;

export type ImageType = keyof typeof IMAGE_TYPES;

/** Whether `mimeType` is one of the image types Pero accepts. */
export function isImageType(
  mimeType: string | undefined,
): mimeType is ImageType {
  return mimeType !== undefined && Object.hasOwn(IMAGE_TYPES, mimeType);
}

/** The type of the image saved at `path`, from its extension; null for none. */
export function imageTypeOf(path: string): ImageType | null {
  const extension = extname(path).slice(1).toLowerCase();
  const found = Object.entries(IMAGE_TYPES).find(
    ([, known]) => known === extension,
  );
  return found === undefined ? null : (found[0] as ImageType);
}
