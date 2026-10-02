import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNotes, scanSystemFolder } from './scan.js';

describe('scanSystemFolder', () => {
  let root: string;
  let system: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pero-scan-'));
    system = join(root, 'System');
    await mkdir(system);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(file: string, text: string, base = system) {
    await mkdir(dirname(join(base, file)), { recursive: true });
    await writeFile(join(base, file), text);
  }

  it('finds notes in subfolders, sorted by path', async () => {
    await write('Pero.md', '---\nprovider: claude\n---');
    await write('Workflows/Weekly.md', 'Go');
    await write('Channels/Main.md', 'Hi');
    await write('Channels/Coaches/Running.md', 'Run');
    const entries = await scanSystemFolder(system);
    expect(entries.map((entry) => entry.file)).toEqual([
      'Channels/Coaches/Running.md',
      'Channels/Main.md',
      'Pero.md',
      'Workflows/Weekly.md',
    ]);
    expect(entries[2]).toEqual({
      file: 'Pero.md',
      size: 24,
      mtimeMs: expect.any(Number),
    });
  });

  it('reports size and modification time', async () => {
    await write('Channels/Main.md', 'Hello');
    const when = new Date('2026-01-02T03:04:05Z');
    await utimes(join(system, 'Channels/Main.md'), when, when);
    expect(await scanSystemFolder(system)).toEqual([
      { file: 'Channels/Main.md', size: 5, mtimeMs: when.getTime() },
    ]);
  });

  it('skips ignored files and never enters folders other than Channels/ and Workflows/', async () => {
    await write('Channels/Main.md', 'Hi');
    await write('Channels/_Template.md', 'Template');
    await write('Channels/.Hidden.md', 'Hidden');
    await write('Channels/avatar.png', 'png');
    await write('_Drafts/Channels/Old.md', 'Old');
    await write('.obsidian/workspace.md', 'Obsidian');
    await write('.trash/Channels/Gone.md', 'Gone');
    await write('Templates/Daily Journal.md', 'Journal');
    await write('Notes.md', 'Stray');
    expect((await scanSystemFolder(system)).map((entry) => entry.file)).toEqual(
      ['Channels/Main.md'],
    );
  });

  it('reads linked notes but does not enter linked folders', async () => {
    await write('Shared/Coach.md', 'Coach', root);
    await write('Channels/Main.md', 'Hi');
    await symlink(
      join(root, 'Shared/Coach.md'),
      join(system, 'Channels/Coach.md'),
    );
    await symlink(join(root, 'Shared'), join(system, 'Channels/Linked'));
    await symlink(join(root, 'missing.md'), join(system, 'Channels/Dangling.md'));
    expect((await scanSystemFolder(system)).map((entry) => entry.file)).toEqual(
      ['Channels/Coach.md', 'Channels/Main.md'],
    );
  });

  it('finds no notes in a missing folder', async () => {
    expect(await scanSystemFolder(join(root, 'Missing'))).toEqual([]);
  });

  it('reads the notes, leaving out one removed since the scan', async () => {
    await write('Channels/Main.md', 'Hi');
    await write('Channels/Health.md', 'Coach');
    const entries = await scanSystemFolder(system);
    await rm(join(system, 'Channels/Main.md'));
    expect(await readNotes(system, entries)).toEqual([
      { file: 'Channels/Health.md', text: 'Coach' },
    ]);
  });

  it('scans 500 notes quickly', async () => {
    await Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        write(`Channels/Group ${index % 10}/Agent ${index}.md`, `Agent ${index}`),
      ),
    );
    const started = performance.now();
    const entries = await scanSystemFolder(system);
    await readNotes(system, entries);
    expect(entries).toHaveLength(500);
    // Generous, so a slow CI machine stays green; typically tens of ms.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
