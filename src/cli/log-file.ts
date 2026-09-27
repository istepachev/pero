import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHUNK_BYTES = 64 * 1024;

const NEWLINE = 0x0a;

export interface LastLines {
  /** Complete lines, oldest first, without blank ones. */
  lines: string[];
  /** Byte offset just past the last complete line; follow from here. */
  end: number;
}

/**
 * The last `count` complete lines of `path`, read backwards from the end so
 * a large log is never read in full. A trailing line without its newline is
 * still being written and is left out. Null when the file is missing.
 */
export function readLastLines(path: string, count: number): LastLines | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    let position = fstatSync(fd).size;
    let tail = Buffer.alloc(0);
    let newlines = 0;
    // One newline ends the last complete line; each earlier one starts a line.
    while (position > 0 && newlines <= count) {
      const length = Math.min(CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      readSync(fd, chunk, 0, length, position);
      newlines += chunk.filter((byte) => byte === NEWLINE).length;
      tail = Buffer.concat([chunk, tail]);
    }

    const last = tail.lastIndexOf(NEWLINE);
    if (last === -1) return { lines: [], end: position };
    const lines = tail.subarray(0, last).toString('utf8').split('\n');
    // Unless the file starts here, the first piece may be part of a line.
    if (position > 0) lines.shift();
    return {
      lines: lines.filter((line) => line !== '').slice(-count),
      end: position + last + 1,
    };
  } finally {
    closeSync(fd);
  }
}

export interface FollowOptions {
  /** Byte offset to start from, usually `LastLines.end`. */
  from: number;
  /** Called with each complete, non-blank line as it is written. */
  onLine: (line: string) => void;
  /** Stops following; otherwise it never ends. */
  signal?: AbortSignal;
  pollMs?: number;
}

/**
 * Streams lines appended to `path` until `signal` aborts. It polls rather
 * than watching, which behaves the same on Linux and macOS: a missing file
 * is read from the start once it appears, and a truncated or replaced one
 * from the start again.
 */
export async function followFile(
  path: string,
  { from, onLine, signal, pollMs = 250 }: FollowOptions,
): Promise<void> {
  let offset = from;
  let inode: number | undefined;
  let partial = Buffer.alloc(0);

  while (!signal?.aborted) {
    const stats = statOrNull(path);
    if (!stats) {
      offset = 0;
      inode = undefined;
      partial = Buffer.alloc(0);
    } else {
      if ((inode !== undefined && stats.ino !== inode) || stats.size < offset) {
        offset = 0;
        partial = Buffer.alloc(0);
      }
      inode = stats.ino;
      if (stats.size > offset) {
        const appended = readRange(path, offset, stats.size);
        offset += appended.length;
        const buffer = Buffer.concat([partial, appended]);
        const last = buffer.lastIndexOf(NEWLINE);
        if (last === -1) {
          partial = buffer;
        } else {
          partial = buffer.subarray(last + 1);
          for (const line of buffer
            .subarray(0, last)
            .toString('utf8')
            .split('\n')) {
            if (line !== '') onLine(line);
          }
        }
      }
    }

    try {
      await sleep(pollMs, undefined, { signal });
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    }
  }
}

/** Bytes of `path` from `start` up to `end`, or fewer if it shrank. */
function readRange(path: string, start: number, end: number): Buffer {
  const buffer = Buffer.alloc(end - start);
  const fd = openSync(path, 'r');
  try {
    let read = 0;
    while (read < buffer.length) {
      const bytes = readSync(
        fd,
        buffer,
        read,
        buffer.length - read,
        start + read,
      );
      if (bytes === 0) break;
      read += bytes;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function statOrNull(path: string) {
  try {
    return statSync(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
