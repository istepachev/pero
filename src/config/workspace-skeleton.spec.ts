import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseNote } from '../system-files/note.js';
import {
  readChannelNote,
  readPeroNote,
  readTextNote,
} from '../system-files/schemas.js';
import { STATE_GITIGNORE } from './workspace-layout.js';
import { defaultHostConfig, readHostConfig } from './host-config.js';
import {
  initWorkspace,
  peroNote,
  WorkspaceInitError,
} from './workspace-skeleton.js';

describe('initWorkspace', () => {
  let tmp: string;
  let home: string;
  let dir: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pero-init-')));
    home = join(tmp, 'home');
    dir = join(home, 'workspace');
    mkdirSync(home);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const read = (path: string) => readFileSync(join(dir, path), 'utf8');

  it('writes the skeleton of a new workspace', () => {
    const { workspace, entries } = initWorkspace(dir, home);

    expect(workspace).toBe(dir);
    expect(entries).toEqual([
      { path: '.gitignore', action: 'created' },
      { path: '.pero/.gitignore', action: 'created' },
      { path: '.pero/config.yaml', action: 'created' },
      { path: 'data/System/Pero.md', action: 'created' },
      { path: 'data/System/Persona.md', action: 'created' },
      { path: 'data/System/Instructions.md', action: 'created' },
      { path: 'data/System/Channels/Default.md', action: 'created' },
      { path: 'data/System/Workflows/', action: 'created' },
    ]);
    expect(read('.gitignore')).toBe('.env\n');
    expect(read('.pero/.gitignore')).toBe(STATE_GITIGNORE);
    expect(read('.pero/config.yaml')).toBe(defaultHostConfig());
    expect(statSync(join(dir, '.pero')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(dir, 'data/System/Workflows'))).toEqual([]);
    expect(readdirSync(join(dir, 'data/System/Channels'))).toEqual([
      'Default.md',
    ]);
  });

  it('changes nothing the second time', () => {
    initWorkspace(dir, home);
    const before = read('data/System/Pero.md');

    const { entries } = initWorkspace(dir, home);

    expect(entries.every((entry) => entry.action === 'kept')).toBe(true);
    expect(read('data/System/Pero.md')).toBe(before);
  });

  it('fills in only what a cloned workspace is missing', () => {
    mkdirSync(join(dir, '.pero'), { recursive: true });
    mkdirSync(join(dir, 'vault', 'System'), { recursive: true });
    writeFileSync(join(dir, '.gitignore'), 'node_modules/');
    writeFileSync(join(dir, '.pero', 'config.yaml'), 'data: vault\n');
    writeFileSync(join(dir, 'vault', 'System', 'Persona.md'), 'Mine.\n');

    const { entries } = initWorkspace(dir, home);

    expect(entries).toEqual([
      { path: '.gitignore', action: 'updated' },
      { path: '.pero/.gitignore', action: 'created' },
      { path: '.pero/config.yaml', action: 'kept' },
      { path: 'vault/System/Pero.md', action: 'created' },
      { path: 'vault/System/Persona.md', action: 'kept' },
      { path: 'vault/System/Instructions.md', action: 'created' },
      { path: 'vault/System/Channels/Default.md', action: 'created' },
      { path: 'vault/System/Workflows/', action: 'created' },
    ]);
    expect(read('.gitignore')).toBe('node_modules/\n.env\n');
    expect(read('.pero/config.yaml')).toBe('data: vault\n');
    expect(read('vault/System/Persona.md')).toBe('Mine.\n');
    expect(existsSync(join(dir, 'data'))).toBe(false);
  });

  it('puts the notes where config.yaml names the system folder', () => {
    mkdirSync(join(dir, '.pero'), { recursive: true });
    writeFileSync(join(dir, '.pero', 'config.yaml'), 'system: pero\n');

    initWorkspace(dir, home);

    expect(existsSync(join(dir, 'pero', 'Pero.md'))).toBe(true);
    expect(readHostConfig(join(dir, '.pero', 'config.yaml'))?.system).toBe(
      'pero',
    );
  });

  it('writes notes the system notes loader reads, with every setting shown', () => {
    initWorkspace(dir, home);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const load = (file: string) => {
      const parsed = parseNote(file, read(file));
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      return parsed.note;
    };

    const pero = load('data/System/Pero.md');
    expect(pero.properties).toEqual({
      provider: null,
      'claude-model': null,
      'claude-effort': null,
      'codex-model': null,
      'codex-effort': null,
      permissions: null,
      timezone,
      'history-carryover': 50,
      'history-retention-days': null,
      'max-concurrent-runs': 2,
    });
    expect(readPeroNote('Pero.md', pero)).toEqual({
      ok: true,
      value: {
        provider: 'claude',
        providerDefaults: {
          claude: { model: null, effort: null },
          codex: { model: null, effort: null },
        },
        permissions: 'ask',
        timezone,
        historyCarryover: 50,
        historyRetentionDays: null,
        maxConcurrentRuns: 2,
      },
    });

    for (const file of ['Persona.md', 'Instructions.md']) {
      const text = load(`data/System/${file}`);
      expect(readTextNote(file, text)).toMatchObject({ ok: true });
      expect(text.body).not.toBeNull();
    }

    // Default.md's settings show empty, so it follows Pero.md.
    const main = load('data/System/Channels/Default.md');
    expect(main.properties).toEqual({
      provider: null,
      model: null,
      effort: null,
      permissions: null,
    });
    expect(readChannelNote('Channels/Default.md', main)).toMatchObject({
      ok: true,
      value: {
        provider: null,
        model: null,
        effort: null,
        permissions: null,
        workingDirectory: null,
      },
    });
  });

  it("sets the host's time zone in Pero.md, where the owner can change it", () => {
    expect(peroNote('UTC')).toContain(
      "\ntimezone: UTC                 # this server's; set yours, such as Europe/Berlin\n",
    );
    // A long name still leaves a space before the comment.
    expect(peroNote('America/Argentina/Buenos_Aires')).toContain(
      "\ntimezone: America/Argentina/Buenos_Aires # this server's;",
    );
  });

  it('refuses the home folder', () => {
    expect(() => initWorkspace(home, home)).toThrow(WorkspaceInitError);
    expect(() => initWorkspace(home, home)).toThrow(
      `${home} is your home folder, which can't be a workspace: every folder under it would find it. Use a folder of its own, such as ~/workspace.`,
    );
  });
});
