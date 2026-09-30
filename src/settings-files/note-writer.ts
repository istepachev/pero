import { Document } from 'yaml';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** A property value a note can hold. */
export type NoteValue =
  string | number | boolean | readonly (string | number)[];

/**
 * The text of a note with `properties`, in the order given, and `body`.
 * Values are written as YAML 1.2, the way `parseNote` reads them back, so
 * text that would read as something else, such as `2026` or `5.5`, is
 * quoted. A note without properties is its body alone, unless the body
 * itself starts with a `---` line, which would read as properties.
 */
export function formatNote(
  properties: ReadonlyArray<readonly [string, NoteValue]>,
  body: string | null,
): string {
  const text = body?.trim() ?? '';
  const lines = text === '' ? [] : [text];
  if (properties.length === 0 && text.split('\n')[0]!.trimEnd() !== '---') {
    return lines.length === 0 ? '' : `${text}\n`;
  }
  const frontmatter =
    properties.length === 0
      ? ''
      : new Document(Object.fromEntries(properties), {
          version: '1.2',
        }).toString({ lineWidth: 0 });
  return ['---', `${frontmatter}---`, ...lines, ''].join('\n');
}
