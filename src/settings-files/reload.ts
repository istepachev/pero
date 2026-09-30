import { readNotes, scanSettingsFolder } from './scan.js';
import type { SettingsError } from './settings-error.js';
import {
  buildSnapshot,
  readNote,
  type SettingsSnapshot,
  type SnapshotContext,
  type SnapshotNote,
  type TopicLookup,
} from './snapshot.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** What one rescan changed. */
export interface SettingsReload {
  snapshot: SettingsSnapshot;
  /**
   * Notes that changed, appeared, or were removed, by path; none when only
   * the topics references resolve against did.
   */
  changed: string[];
  /** Errors the previous snapshot didn't have. */
  appeared: SettingsError[];
  /** Errors of the previous snapshot this one no longer has. */
  fixed: SettingsError[];
}

interface Stat {
  size: number;
  mtimeMs: number;
}

/** What the reloader knows of one note. */
interface NoteState {
  /** The version read last. */
  stat: Stat;
  /** The version in use; null while the note is new and not used yet. */
  text: string | null;
  /** The latest version that read without errors, if any. */
  lastGood: string | null;
  /** A version with errors, seen in one scan and not used until another. */
  pending: (Stat & { text: string }) | null;
}

/**
 * Keeps a snapshot of the settings folder's notes up to date by rescanning
 * it. A rescan stats every note and reads only those whose size or
 * modification time changed.
 *
 * A save can be caught half written, so a changed note with errors is used
 * only once a second scan finds it unchanged: until then its previous
 * version stays. Once used, a note with errors is reported, and its last
 * good version, if Pero read one since it started, stays in use.
 */
export class SettingsReloader {
  private readonly notes = new Map<string, NoteState>();
  private snapshot: SettingsSnapshot | null = null;
  /** Whether the next rescan rebuilds the snapshot, notes changed or not. */
  private stale = false;

  constructor(
    private readonly settingsFolder: string,
    private context: SnapshotContext,
  ) {}

  /**
   * Resolves Workflow references with `topics` from the next rescan on,
   * which rebuilds the snapshot even when no note changed.
   */
  setTopics(topics: TopicLookup): void {
    this.context = { ...this.context, topics };
    this.stale = true;
  }

  /** The snapshot in use; null before the first rescan. */
  current(): SettingsSnapshot | null {
    return this.snapshot;
  }

  /**
   * Scans the settings folder and returns what changed, or null when the
   * snapshot stays as it is. The first rescan uses every note as it is,
   * errors and all: there is no previous version to keep.
   */
  async rescan(): Promise<SettingsReload | null> {
    const first = this.snapshot === null;
    const entries = await scanSettingsFolder(this.settingsFolder);
    const changed = new Set<string>();
    const toRead = new Map<string, Stat>();
    const present = new Set<string>();

    for (const entry of entries) {
      present.add(entry.file);
      const state = this.notes.get(entry.file);
      if (state !== undefined && sameStat(state.stat, entry)) {
        // A version with errors that stayed the same since the last scan.
        if (state.pending !== null && sameStat(state.pending, entry)) {
          state.text = state.pending.text;
          state.pending = null;
          changed.add(entry.file);
        }
        continue;
      }
      toRead.set(entry.file, entry);
    }
    for (const [file, state] of this.notes) {
      if (present.has(file)) continue;
      this.notes.delete(file);
      if (state.text !== null) changed.add(file);
    }

    const read = await readNotes(
      this.settingsFolder,
      [...toRead].map(([file, stat]) => ({ file, ...stat })),
    );
    for (const { file, text } of read) {
      const stat = toRead.get(file)!;
      const state = this.notes.get(file) ?? {
        stat,
        text: null,
        lastGood: null,
        pending: null,
      };
      this.notes.set(file, state);
      state.stat = { size: stat.size, mtimeMs: stat.mtimeMs };
      if (text === state.text) {
        // Touched, not changed; a version still waiting is dropped.
        state.pending = null;
        continue;
      }
      const good = readNote(file, text).errors.length === 0;
      if (good || first) {
        state.text = text;
        if (good) state.lastGood = text;
        state.pending = null;
        changed.add(file);
      } else {
        state.pending = { ...state.stat, text };
      }
    }

    if (!first && !this.stale && changed.size === 0) return null;
    this.stale = false;
    const previous = this.snapshot;
    this.snapshot = buildSnapshot(this.snapshotNotes(), this.context);
    const before = previous?.errors ?? [];
    return {
      snapshot: this.snapshot,
      changed: [...changed].sort(),
      appeared: without(this.snapshot.errors, before),
      fixed: without(before, this.snapshot.errors),
    };
  }

  private snapshotNotes(): SnapshotNote[] {
    const notes: SnapshotNote[] = [];
    for (const [file, { text, lastGood }] of this.notes) {
      if (text === null) continue;
      notes.push(
        lastGood === null || lastGood === text
          ? { file, text }
          : { file, text, fallback: lastGood },
      );
    }
    return notes.sort((a, b) =>
      a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
    );
  }
}

function sameStat(a: Stat, b: Stat): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** The errors in `errors` that `other` doesn't have. */
function without(
  errors: readonly SettingsError[],
  other: readonly SettingsError[],
): SettingsError[] {
  const keys = new Set(other.map(key));
  return errors.filter((error) => !keys.has(key(error)));
}

function key(error: SettingsError): string {
  return JSON.stringify([error.file, error.property, error.message]);
}
