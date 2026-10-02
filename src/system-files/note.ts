import { LineCounter, parseDocument, type YAMLError } from 'yaml';
import type { NoteError } from './note-error.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** A note split into its properties and its body. */
export interface ParsedNote {
  /** The frontmatter's properties, as YAML gives them; empty without any. */
  properties: Record<string, unknown>;
  /** The text after the frontmatter, trimmed; null when there is none. */
  body: string | null;
}

export type NoteParse =
  { ok: true; note: ParsedNote } | { ok: false; errors: NoteError[] };

const DELIMITER = '---';

/**
 * Splits `text`, the note at `file`, into its frontmatter properties and
 * its body, as Obsidian does: frontmatter is YAML between a `---` first
 * line and the next `---` line. It is read as YAML 1.2, so `12:00` and
 * `yes` stay strings. A note without frontmatter is all body.
 */
export function parseNote(file: string, text: string): NoteParse {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trimEnd() !== DELIMITER) {
    return { ok: true, note: { properties: {}, body: bodyOf(lines) } };
  }
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trimEnd() === DELIMITER,
  );
  if (end === -1) {
    return failure(
      file,
      `the properties that start on line 1 have no closing ${DELIMITER} line`,
    );
  }

  const lineCounter = new LineCounter();
  const document = parseDocument(lines.slice(1, end).join('\n'), {
    version: '1.2',
    schema: 'core',
    uniqueKeys: true,
    prettyErrors: false,
    lineCounter,
  });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0) {
    return {
      ok: false,
      errors: problems.map((problem) => ({
        file,
        property: null,
        message: describeYamlError(problem, lineCounter),
      })),
    };
  }

  let value: unknown;
  try {
    value = document.toJS();
  } catch (error) {
    return failure(
      file,
      `properties: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
    return failure(file, 'properties must be "name: value" lines');
  }
  return {
    ok: true,
    note: {
      properties: (value ?? {}) as Record<string, unknown>,
      body: bodyOf(lines.slice(end + 1)),
    },
  };
}

function bodyOf(lines: readonly string[]): string | null {
  const body = lines.join('\n').trim();
  return body === '' ? null : body;
}

function failure(file: string, message: string): NoteParse {
  return { ok: false, errors: [{ file, property: null, message }] };
}

/** `problem`'s message with its line in the note, counting the `---`. */
function describeYamlError(
  problem: YAMLError,
  lineCounter: LineCounter,
): string {
  const { line } = lineCounter.linePos(problem.pos[0]);
  const message = problem.message.split('\n')[0]!.replace(/[.:]$/, '');
  return `line ${line + 1}: ${message}`;
}
