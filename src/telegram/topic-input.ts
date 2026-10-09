import { z } from 'zod';

/** Telegram forum topic names: nonempty, at most 128 characters. */
export const topicNameSchema = z
  .string()
  .trim()
  .min(1, 'give the topic a name')
  .max(128, 'must be at most 128 characters')
  .refine(
    (name) =>
      name
        .split('')
        .every(
          (character) =>
            character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
    { message: 'must not contain control characters' },
  );
