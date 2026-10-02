import type { NoteError } from './note-error.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** Properties Obsidian itself uses, allowed in any note and ignored. */
export const OBSIDIAN_PROPERTIES: ReadonlySet<string> = new Set([
  'tags',
  'aliases',
  'cssclasses',
]);

/** The most edits apart a typo may be from the property it suggests. */
const MAX_SUGGESTION_DISTANCE = 2;

/**
 * `properties` without Obsidian's own, and an error for each one not in
 * `known`, suggesting the known property it is closest to, so a typo like
 * `modle:` doesn't pass silently.
 */
export function checkPropertyNames(
  file: string,
  properties: Readonly<Record<string, unknown>>,
  known: readonly string[],
): { properties: Record<string, unknown>; errors: NoteError[] } {
  const kept: Record<string, unknown> = {};
  const errors: NoteError[] = [];
  for (const [property, value] of Object.entries(properties)) {
    if (OBSIDIAN_PROPERTIES.has(property)) continue;
    if (known.includes(property)) {
      kept[property] = value;
      continue;
    }
    const suggestion = closest(property, known);
    errors.push({
      file,
      property,
      message:
        suggestion === null
          ? 'unknown property'
          : `unknown property (did you mean ${suggestion}?)`,
    });
  }
  return { properties: kept, errors };
}

/** The candidate fewest edits from `word`, if any is close enough. */
function closest(word: string, candidates: readonly string[]): string | null {
  const lower = word.toLowerCase();
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(lower, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  // A short word is a few edits from anything, so it must be closer still.
  const limit = Math.min(MAX_SUGGESTION_DISTANCE, lower.length - 1);
  return bestDistance <= limit ? best : null;
}

/**
 * Levenshtein distance, with swapping two neighbouring letters counted as
 * one edit, since that is the commonest typo.
 */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const columns = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: columns }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < columns; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[a.length]![b.length]!;
}
