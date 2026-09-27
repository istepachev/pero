import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followFile, readLastLines } from './log-file.js';

describe('log files', () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-log-file-'));
    file = join(tmp, 'pero.log');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const numbered = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`);

  describe('readLastLines', () => {
    it('returns the last lines of a file larger than one read', () => {
      // Long lines, so the last ten span more than one 64 KiB chunk.
      const lines = numbered(1, 100).map((line) => line.padEnd(10_000, '.'));
      writeFileSync(file, lines.map((line) => `${line}\n`).join(''));

      const last = readLastLines(file, 10);

      expect(last?.lines).toEqual(lines.slice(-10));
      expect(last?.end).toBe(100 * 10_001);
    });

    it('returns every line when there are fewer than asked for', () => {
      writeFileSync(file, 'a\n\nb\n');

      expect(readLastLines(file, 50)).toEqual({ lines: ['a', 'b'], end: 5 });
    });

    it('returns nothing for an empty file', () => {
      writeFileSync(file, '');

      expect(readLastLines(file, 5)).toEqual({ lines: [], end: 0 });
    });

    it('leaves out a line that is still being written', () => {
      writeFileSync(file, 'a\nb\npart');

      expect(readLastLines(file, 5)).toEqual({ lines: ['a', 'b'], end: 4 });
      writeFileSync(file, 'part');
      expect(readLastLines(file, 5)).toEqual({ lines: [], end: 0 });
    });

    it('returns null when the file or its directory is missing', () => {
      expect(readLastLines(file, 5)).toBeNull();
      expect(readLastLines(join(tmp, 'logs', 'pero.log'), 5)).toBeNull();
    });
  });

  describe('followFile', () => {
    let controller: AbortController;
    let received: string[];
    let following: Promise<void> | undefined;

    beforeEach(() => {
      controller = new AbortController();
      received = [];
    });

    afterEach(async () => {
      controller.abort();
      await following;
    });

    function follow(from: number): void {
      following = followFile(file, {
        from,
        pollMs: 10,
        signal: controller.signal,
        onLine: (line) => received.push(line),
      });
    }

    it('streams lines written after the tail, without a gap or repeat', async () => {
      writeFileSync(file, 'old 1\nold 2\nnew 1 part');
      const last = readLastLines(file, 1)!;
      expect(last.lines).toEqual(['old 2']);

      follow(last.end);
      appendFileSync(file, 'ial\nnew 2\n');
      await vi.waitFor(() =>
        expect(received).toEqual(['new 1 partial', 'new 2']),
      );
      appendFileSync(file, 'new 3\n\nnew 4');
      await vi.waitFor(() => expect(received).toContain('new 3'));
      appendFileSync(file, '\n');

      await vi.waitFor(() =>
        expect(received).toEqual(['new 1 partial', 'new 2', 'new 3', 'new 4']),
      );
    });

    it('waits for a missing file and reads it from the start', async () => {
      follow(0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      writeFileSync(file, 'first\nsecond\n');

      await vi.waitFor(() => expect(received).toEqual(['first', 'second']));
    });

    it('starts over after the file is truncated or replaced', async () => {
      writeFileSync(file, 'before\n');
      follow(readLastLines(file, 1)!.end);

      truncateSync(file, 0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      appendFileSync(file, 'after truncate\n');
      await vi.waitFor(() => expect(received).toEqual(['after truncate']));

      const replacement = join(tmp, 'next.log');
      writeFileSync(replacement, 'after replace, longer than the old file\n');
      renameSync(replacement, file);

      await vi.waitFor(() =>
        expect(received).toEqual([
          'after truncate',
          'after replace, longer than the old file',
        ]),
      );
    });

    it('resolves once aborted', async () => {
      writeFileSync(file, '');
      follow(0);

      controller.abort();

      await expect(following).resolves.toBeUndefined();
      appendFileSync(file, 'late\n');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(received).toEqual([]);
    });
  });
});
