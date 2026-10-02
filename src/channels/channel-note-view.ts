import { join } from 'node:path';
import { InvalidInputError } from '../common/errors.js';
import { validateWorkingDirectory } from '../config/working-directory.js';
import type { ChannelNoteView } from '../control/protocol.js';
import { shownPath } from '../system-files/note-paths.js';
import { channelOrigins } from '../system-files/origins.js';
import type { ChannelNote, SystemSnapshot } from '../system-files/snapshot.js';

/**
 * `note` as the CLI and `/status` show it: its settings with defaults
 * resolved, where each comes from, and its note's errors.
 */
export function channelNoteView(
  note: ChannelNote,
  snapshot: Pick<SystemSnapshot, 'peroProperties' | 'errors'> | null,
  folders: { workspace: string; systemFolder: string },
): ChannelNoteView {
  return {
    name: note.name,
    title: note.title,
    file:
      note.file === null
        ? null
        : shownPath(folders.workspace, join(folders.systemFolder, note.file)),
    channelId: note.channelId,
    provider: note.provider,
    model: note.model,
    effort: note.effort,
    workingDirectory:
      note.note.workingDirectory === null ? null : note.workingDirectory,
    effectiveWorkingDirectory: note.workingDirectory,
    instructions: note.instructions,
    permissions: note.permissions,
    skipGitRepoCheck: note.skipGitRepoCheck,
    enabled: note.enabled,
    origins: channelOrigins(note, snapshot?.peroProperties ?? new Set()),
    errors: (snapshot?.errors ?? [])
      .filter((error) => error.file === note.file)
      .map(({ property, message }) => ({ property, message })),
  };
}

/** Why `folder`, where turns run, cannot be used now, such as a missing vault. */
export async function folderProblem(folder: string): Promise<string | null> {
  try {
    await validateWorkingDirectory(folder);
    return null;
  } catch (error) {
    if (error instanceof InvalidInputError) return error.message;
    throw error;
  }
}
