import { describe, expect, it } from 'vitest';
import { isIgnoredPath, noteIdentity } from './note-files.js';

describe('isIgnoredPath', () => {
  it('keeps Markdown notes, in subfolders too', () => {
    for (const file of [
      'Pero.md',
      'Agents/Health.md',
      'Agents/Coaches/Running.md',
      'Workflows/Weekly health report.md',
    ]) {
      expect(isIgnoredPath(file)).toBe(false);
    }
  });

  it('skips names and folders that start with _ or .', () => {
    for (const file of [
      'Agents/_Template.md',
      '_Ideas.md',
      '.obsidian/workspace.md',
      'Agents/.hidden.md',
      'Agents/_Drafts/Health.md',
      '.trash/Agents/Old.md',
    ]) {
      expect(isIgnoredPath(file)).toBe(true);
    }
  });

  it('skips anything that is not a .md file', () => {
    for (const file of [
      'Agents/Health.txt',
      'Agents/Health.md.bak',
      'Agents/avatar.png',
      'Agents/Health',
    ]) {
      expect(isIgnoredPath(file)).toBe(true);
    }
  });
});

describe('noteIdentity', () => {
  it('names Pero.md at the root', () => {
    expect(noteIdentity('Pero.md')).toEqual({
      ok: true,
      identity: { kind: 'pero', title: 'Pero', name: 'pero' },
    });
  });

  it('names Agents and Workflows by their file name', () => {
    expect(noteIdentity('Agents/Weekly Health.md')).toEqual({
      ok: true,
      identity: {
        kind: 'agent',
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
    expect(noteIdentity('Agents/Coaches/Running.md')).toEqual({
      ok: true,
      identity: { kind: 'agent', title: 'Running', name: 'running' },
    });
  });

  it('makes names the way topic names are made', () => {
    const name = (file: string) => {
      const result = noteIdentity(file);
      return result.ok ? result.identity.name : null;
    };
    expect(name('Agents/Café.md')).toBe('cafe');
    expect(name('Agents/Здоровье.md')).toBe('zdorove');
    expect(name('Agents/Q3 — Review!.md')).toBe('q3-review');
  });

  it('refuses a file name without letters or digits', () => {
    expect(noteIdentity('Agents/!!!.md')).toEqual({
      ok: false,
      error: {
        file: 'Agents/!!!.md',
        property: null,
        message: 'the file name needs a letter or digit to make a name from',
      },
    });
  });

  it('refuses notes outside Pero.md, Agents/, and Workflows/', () => {
    for (const file of [
      'Notes.md',
      'pero.md',
      'Agent/Health.md',
      'agents/Health.md',
      'Archive/Agents/Health.md',
      'Agents.md',
    ]) {
      expect(noteIdentity(file)).toEqual({
        ok: false,
        error: {
          file,
          property: null,
          message:
            'not an Agent or Workflow note; move it under Agents/ or Workflows/, or start its name with _',
        },
      });
    }
  });
});
