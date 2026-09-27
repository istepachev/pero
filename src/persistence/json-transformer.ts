import type { ValueTransformer } from 'typeorm';
import { z } from 'zod';

/** A JSON object whose shape a later schema will pin down. */
export const jsonObject = z.record(z.string(), z.unknown());

/**
 * Stores a value as JSON text, validated in both directions, so an invalid
 * value is never written and a corrupted one fails loudly on read. `null`
 * passes through for nullable columns, `undefined` for partial updates.
 *
 * Give such a column no database default: after an insert, TypeORM 1.1
 * reloads defaulted columns and runs `from` on the already parsed value.
 */
export function jsonTransformer<T>(schema: z.ZodType<T>): ValueTransformer {
  return {
    to: (value?: T | null) =>
      value === undefined || value === null
        ? value
        : JSON.stringify(schema.parse(value)),
    from: (value: string | null) =>
      value === null ? null : schema.parse(JSON.parse(value)),
  };
}
