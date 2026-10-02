import { describe, expect, it } from 'vitest';
import { isIgnoredPath, noteIdentity } from './note-files.js';

describe('isIgnoredPath', () => {
  it('keeps Markdown notes, in subfolders too', () => {
    for (const file of [
      'Pero.md',
      'Persona.md',
      'Instructions.md',
      'Channels/Health.md',
      'Channels/Coaches/Running.md',
      'Workflows/Weekly health report.md',
    ]) {
      expect(isIgnoredPath(file)).toBe(false);
    }
  });

  it('skips names and folders that start with _ or .', () => {
    for (const file of [
      'Channels/_Template.md',
      '_Ideas.md',
      '.obsidian/workspace.md',
      'Channels/.hidden.md',
      'Channels/_Drafts/Health.md',
      '.trash/Channels/Old.md',
    ]) {
      expect(isIgnoredPath(file)).toBe(true);
    }
  });

  it("skips the owner's files outside Pero.md, Channels/, and Workflows/", () => {
    for (const file of [
      'Templates/Daily Journal.md',
      'Notes.md',
      'pero.md',
      'Channel/Health.md',
      'channels/Health.md',
      'Archive/Channels/Health.md',
      'Channels.md',
      'Agents/Health.md',
    ]) {
      expect(isIgnoredPath(file)).toBe(true);
    }
  });

  it('skips anything that is not a .md file', () => {
    for (const file of [
      'Channels/Health.txt',
      'Channels/Health.md.bak',
      'Channels/avatar.png',
      'Channels/Health',
    ]) {
      expect(isIgnoredPath(file)).toBe(true);
    }
  });
});

describe('noteIdentity', () => {
  it('names Pero.md, Persona.md, and Instructions.md at the root', () => {
    expect(noteIdentity('Pero.md')).toEqual({
      ok: true,
      identity: { kind: 'pero', title: 'Pero', name: 'pero' },
    });
    expect(noteIdentity('Persona.md')).toMatchObject({
      identity: { kind: 'persona' },
    });
    expect(noteIdentity('Instructions.md')).toMatchObject({
      identity: { kind: 'instructions' },
    });
  });

  it('names Channel notes and Workflows by their file name', () => {
    expect(noteIdentity('Channels/Weekly Health.md')).toEqual({
      ok: true,
      identity: {
        kind: 'channel',
        title: 'Weekly Health',
        name: 'weekly-health',
      },
    });
    expect(noteIdentity('Workflows/Weekly health report.md')).toEqual({
      ok: true,
      identity: {
        kind: 'workflow',
        title: 'Weekly health report',
        name: 'weekly-health-report',
      },
    });
  });

  it('ignores subfolders for the name', () => {
    expect(noteIdentity('Channels/Coaches/Running.md')).toEqual({
      ok: true,
      identity: { kind: 'channel', title: 'Running', name: 'running' },
    });
  });

  it('makes names the way topic names are made', () => {
    const name = (file: string) => {
      const result = noteIdentity(file);
      return result.ok ? result.identity.name : null;
    };
    expect(name('Channels/Café.md')).toBe('cafe');
    expect(name('Channels/Здоровье.md')).toBe('zdorove');
    expect(name('Channels/Q3 — Review!.md')).toBe('q3-review');
  });

  it('refuses a file name without letters or digits', () => {
    expect(noteIdentity('Channels/!!!.md')).toEqual({
      ok: false,
      error: {
        file: 'Channels/!!!.md',
        property: null,
        message: 'the file name needs a letter or digit to make a name from',
      },
    });
  });

  it('refuses notes outside Pero.md, Channels/, and Workflows/', () => {
    for (const file of [
      'Notes.md',
      'pero.md',
      'Channel/Health.md',
      'channels/Health.md',
      'Archive/Channels/Health.md',
      'Channels.md',
      'Agents/Health.md',
    ]) {
      expect(noteIdentity(file)).toEqual({
        ok: false,
        error: {
          file,
          property: null,
          message:
            'not a note Pero reads; Pero reads only Pero.md, Persona.md, Instructions.md, and notes under Channels/ and Workflows/',
        },
      });
    }
  });
});
