import type { z } from 'zod';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/**
 * One problem with a system note, as `pero check`, `pero status`, and the
 * log report it.
 */
export interface NoteError {
  /** The note's path inside the system folder, such as `Agents/Coach.md`. */
  file: string;
  /** The property at fault, as written in the note; null for the whole note. */
  property: string | null;
  message: string;
}

/**
 * `issues` from checking `properties`, the note at `file`, as errors on
 * the property each is about. An issue with one item of a list names the
 * item, counting from 1.
 */
export function fromZodIssues(
  file: string,
  issues: readonly z.core.$ZodIssue[],
  properties: Readonly<Record<string, unknown>>,
): NoteError[] {
  return issues.map((issue) => {
    const [property, index] = issue.path;
    if (property === undefined) {
      return { file, property: null, message: issue.message };
    }
    const item =
      typeof index === 'number' && Array.isArray(properties[String(property)])
        ? ` (item ${index + 1})`
        : '';
    return {
      file,
      property: String(property),
      message: `${issue.message}${item}`,
    };
  });
}
