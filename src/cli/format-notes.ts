import type { ChannelNoteView, NextTurn } from '../control/protocol.js';
import type { ValueOrigin } from '../system-files/origins.js';
import { table } from './format-status.js';
import { preview } from './preview.js';

/** The rows `pero channels show` gives a Channel's settings. */
export function noteRows(note: ChannelNoteView): string[][] {
  const from = (origin: ValueOrigin) =>
    origin === 'pero' ? ' (Pero.md)' : origin === 'default' ? ' (default)' : '';
  const option = (value: string | null, origin: ValueOrigin) =>
    value === null ? '(provider default)' : `${value}${from(origin)}`;
  const { origins } = note;
  return [
    ['note', note.file ?? '(none yet: Pero writes it)'],
    ['provider', `${note.provider}${from(origins.provider)}`],
    ['model', option(note.model, origins.model)],
    ['effort', option(note.effort, origins.effort)],
    ['working directory', folder(note)],
    ['instructions', preview(note.instructions)],
    ['permissions', `${note.permissions}${from(origins.permissions)}`],
    ['codex git check', note.skipGitRepoCheck ? 'skipped' : 'required'],
    ['state', note.enabled ? 'enabled' : 'disabled'],
  ];
}

/** A note's errors, while its last good version stays in use. */
export function noteErrorLines(note: ChannelNoteView): string[] {
  if (note.errors.length === 0) return [];
  return [
    '',
    'Its note has errors, so its last good version is in use:',
    ...note.errors.map(
      ({ property, message }) =>
        `  ${property === null ? '' : `${property}: `}${message}`,
    ),
  ];
}

/** `table`'s rows, indented under a heading. */
export function indented(rows: string[][]): string[] {
  return table(rows).map((row) => `  ${row}`);
}

/** What the next turn in a Channel does with its Session. */
export function describeNextTurn(turn: NextTurn): string {
  const carried = turn.carriesOver
    ? ", with the Channel's recent messages"
    : '';
  switch (turn.kind) {
    case 'new':
      return `starts its first Session${carried}`;
    case 'resume':
      return `resumes Session ${turn.sessionId}`;
    case 'restart':
      return `starts Session ${turn.sessionId} over${carried}`;
    case 'fresh':
      return `fresh Session: ${turn.reason} was ${turn.from}${carried}`;
  }
}

function folder(note: ChannelNoteView): string {
  if (note.workingDirectory !== null) return note.effectiveWorkingDirectory;
  return `${note.effectiveWorkingDirectory} (workspace)`;
}
