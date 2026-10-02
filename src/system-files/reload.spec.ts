import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channelTopicLookup } from '../system/channel-topics.js';
import { SystemReloader } from './reload.js';

describe('SystemReloader', () => {
  let root: string;
  let system: string;
  let reloader: SystemReloader;
  /** Each write gets a later modification time, whatever the clock. */
  let clock: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pero-reload-'));
    system = join(root, 'System');
    await mkdir(system);
    clock = Date.parse('2026-01-01T00:00:00Z');
    reloader = new SystemReloader(system, {
      workspace: root,
      homeDir: root,
      hostTimeZone: 'UTC',
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(file: string, text: string) {
    const path = join(system, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    clock += 1_000;
    await utimes(path, new Date(clock), new Date(clock));
  }

  const agent = (name: string) => reloader.current()!.channelNotes.get(name);

  it('loads every note on the first scan, errors and all', async () => {
    await write('Channels/Health.md', 'Coach');
    await write('Channels/Broken.md', '---\nmodle: x\n---');
    const reload = await reloader.rescan();
    expect(reload).toMatchObject({
      changed: ['Channels/Broken.md', 'Channels/Health.md'],
      appeared: [
        {
          file: 'Channels/Broken.md',
          property: 'modle',
          message: 'unknown property (did you mean model?)',
        },
      ],
      fixed: [],
    });
    expect(agent('health')!.instructions).toBe('Coach');
    expect(agent('broken')).toBeUndefined();
  });

  it('has a snapshot after the first scan of an empty folder', async () => {
    expect(await reloader.rescan()).toMatchObject({ changed: [] });
    expect(reloader.current()!.channelNotes.size).toBe(0);
  });

  it('returns null when nothing changed', async () => {
    await write('Channels/Health.md', 'Coach');
    await reloader.rescan();
    expect(await reloader.rescan()).toBeNull();
  });

  it('shows an edited note after one scan', async () => {
    await write('Channels/Health.md', 'Coach');
    await reloader.rescan();
    await write('Channels/Health.md', '---\nmodel: opus\n---\nBetter coach');
    const reload = await reloader.rescan();
    expect(reload).toMatchObject({ changed: ['Channels/Health.md'] });
    expect(agent('health')).toMatchObject({
      model: 'opus',
      instructions: 'Better coach',
    });
  });

  it('ignores a note that is only touched', async () => {
    await write('Channels/Health.md', 'Coach');
    await reloader.rescan();
    await write('Channels/Health.md', 'Coach');
    expect(await reloader.rescan()).toBeNull();
  });

  it('does not report a note caught mid-write', async () => {
    await write('Channels/Health.md', '---\nmodel: opus\n---\nCoach');
    await reloader.rescan();
    // Half of a save: the frontmatter isn't closed yet.
    await write('Channels/Health.md', '---\nmodel: sonnet\n');
    expect(await reloader.rescan()).toBeNull();
    expect(agent('health')!.model).toBe('opus');
    await write('Channels/Health.md', '---\nmodel: sonnet\n---\nCoach');
    expect(await reloader.rescan()).toMatchObject({ appeared: [], fixed: [] });
    expect(agent('health')!.model).toBe('sonnet');
  });

  it('reports a note broken for two scans, keeping its last good version', async () => {
    await write('Channels/Health.md', '---\nmodel: opus\n---\nCoach');
    await reloader.rescan();
    await write(
      'Channels/Health.md',
      '---\nmodel: opus\neffort: huge\n---\nCoach',
    );
    expect(await reloader.rescan()).toBeNull();

    const reload = await reloader.rescan();
    expect(reload).toMatchObject({
      changed: ['Channels/Health.md'],
      appeared: [{ file: 'Channels/Health.md', property: 'effort' }],
    });
    expect(agent('health')).toMatchObject({ model: 'opus', effort: null });
    expect(reloader.current()!.errors).toHaveLength(1);
    expect(reloader.broken()).toEqual([
      {
        file: 'Channels/Health.md',
        text: '---\nmodel: opus\neffort: huge\n---\nCoach',
        fallback: true,
        errors: reloader.current()!.errors,
      },
    ]);

    // Still broken, differently: reported once it settles, still the last good.
    await write(
      'Channels/Health.md',
      '---\nmodel: opus\nefort: high\n---\nCoach',
    );
    expect(await reloader.rescan()).toBeNull();
    expect(await reloader.rescan()).toMatchObject({
      appeared: [{ property: 'efort' }],
      fixed: [{ property: 'effort' }],
    });
    expect(agent('health')!.model).toBe('opus');

    await write('Channels/Health.md', '---\nmodel: sonnet\n---\nCoach');
    expect(await reloader.rescan()).toMatchObject({
      appeared: [],
      fixed: [{ property: 'efort' }],
    });
    expect(agent('health')!.model).toBe('sonnet');
    expect(reloader.broken()).toEqual([]);
  });

  it('leaves out a note broken since the start until it is fixed', async () => {
    expect(reloader.broken()).toEqual([]);
    await write('Channels/Health.md', '---\nmodle: opus\n---');
    await reloader.rescan();
    expect(agent('health')).toBeUndefined();
    expect(reloader.broken()).toMatchObject([
      {
        file: 'Channels/Health.md',
        fallback: false,
        errors: [{ property: 'modle' }],
      },
    ]);
    await write('Channels/Health.md', '---\nmodel: opus\n---');
    expect(await reloader.rescan()).toMatchObject({
      fixed: [{ property: 'modle' }],
    });
    expect(agent('health')!.model).toBe('opus');
  });

  it('waits a scan before reporting a new note with errors', async () => {
    await reloader.rescan();
    await write('Channels/Health.md', '---\nmodle: opus\n---');
    expect(await reloader.rescan()).toBeNull();
    expect(await reloader.rescan()).toMatchObject({
      changed: ['Channels/Health.md'],
      appeared: [{ property: 'modle' }],
    });
  });

  it('adds a new note, and drops a deleted one', async () => {
    await write('Channels/Health.md', 'Coach');
    await reloader.rescan();
    await write('Channels/Running.md', 'Run');
    expect(await reloader.rescan()).toMatchObject({
      changed: ['Channels/Running.md'],
    });
    expect(agent('running')).toBeDefined();

    await rm(join(system, 'Channels/Health.md'));
    expect(await reloader.rescan()).toMatchObject({
      changed: ['Channels/Health.md'],
    });
    expect(agent('health')).toBeUndefined();
  });

  it('forgets a new note with errors deleted before it was used', async () => {
    await reloader.rescan();
    await write('Channels/Draft.md', '---\nmodle: x\n');
    expect(await reloader.rescan()).toBeNull();
    await rm(join(system, 'Channels/Draft.md'));
    expect(await reloader.rescan()).toBeNull();
  });

  it('resolves references afresh when another note changes', async () => {
    await write(
      'Channels/Health.md',
      '---\nchannel-id: telegram:-1:5\n---\nCoach',
    );
    await write('Workflows/Report.md', '---\nchannel: Health\n---\nGo');
    await reloader.rescan();
    expect(reloader.current()!.workflows.has('report')).toBe(true);

    await rm(join(system, 'Channels/Health.md'));
    expect(await reloader.rescan()).toMatchObject({
      appeared: [
        {
          file: 'Workflows/Report.md',
          property: 'channel',
          message: 'no Channel note named "Health"; Channel notes: none yet',
        },
      ],
    });
    expect(reloader.current()!.workflows.has('report')).toBe(false);
    // Broken though its text is as it was, which is good.
    expect(reloader.broken()).toMatchObject([
      { file: 'Workflows/Report.md', fallback: false },
    ]);
  });

  it('applies Pero.md and the shared instructions to every Channel', async () => {
    await write('Channels/Health.md', 'Coach');
    await reloader.rescan();
    await write('Pero.md', '---\nclaude-model: opus\n---');
    await write('Persona.md', 'Calm');
    await write('Instructions.md', 'Shared');
    await reloader.rescan();
    expect(agent('health')!.model).toBe('opus');
    expect(reloader.current()!.persona).toBe('Calm');
    expect(reloader.current()!.instructions).toBe('Shared');
  });

  it('rescans 500 unchanged notes quickly', async () => {
    await Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        write(
          `Channels/Group ${index % 10}/Channel ${index}.md`,
          `Hi ${index}`,
        ),
      ),
    );
    await reloader.rescan();
    expect(reloader.current()!.channelNotes.size).toBe(500);
    const started = performance.now();
    expect(await reloader.rescan()).toBeNull();
    // Generous, so a slow CI machine stays green; typically a few ms.
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('builds the snapshot again when the topics references resolve against change', async () => {
    await write(
      'Channels/Health.md',
      '---\nchannel-id: telegram:-100777:5\n---',
    );
    await write('Workflows/Report.md', '---\nchannel: Health\n---\nGo');
    reloader.setTopics(channelTopicLookup([]));
    await reloader.rescan();
    expect(reloader.current()!.workflows.size).toBe(0);
    expect(await reloader.rescan()).toBeNull();

    reloader.setTopics(
      channelTopicLookup([
        { id: 5, kind: 'telegram', key: '-100777:5', title: 'Health' },
      ]),
    );
    const reload = await reloader.rescan();
    expect(reload).toMatchObject({
      changed: [],
      appeared: [],
      fixed: [
        expect.objectContaining({
          file: 'Workflows/Report.md',
          property: 'channel',
        }),
      ],
    });
    expect(reloader.current()!.workflows.get('report')!.resolved).toEqual({
      targets: [5],
      history: 'all',
    });
    expect(await reloader.rescan()).toBeNull();
  });
});
