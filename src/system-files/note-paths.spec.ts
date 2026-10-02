import { describe, expect, it } from 'vitest';
import { findChannelNote, findWorkflowNote, shownPath } from './note-paths.js';

describe('note paths', () => {
  it('shows paths inside the workspace relative to it', () => {
    const workspace = '/home/me/workspace';
    expect(shownPath(workspace, `${workspace}/.pero/config.yaml`)).toBe(
      '.pero/config.yaml',
    );
    expect(shownPath(workspace, '/srv/vault/System/Pero.md')).toBe(
      '/srv/vault/System/Pero.md',
    );
  });

  it('finds a Channel note by name or title, in subfolders too', () => {
    const files = [
      'Pero.md',
      'Channels/Main.md',
      'Channels/Home/Health Coach.md',
      'Workflows/Health Coach.md',
    ];
    expect(findChannelNote(files, 'health-coach')).toBe(
      'Channels/Home/Health Coach.md',
    );
    expect(findChannelNote(files, 'Health Coach')).toBe(
      'Channels/Home/Health Coach.md',
    );
    expect(findChannelNote(files, 'MAIN')).toBe('Channels/Main.md');
    expect(findChannelNote(files, 'coach')).toBeNull();
  });

  it('finds a Workflow note by name or title, in subfolders too', () => {
    const files = [
      'Channels/Weekly Report.md',
      'Workflows/Health/Weekly Report.md',
    ];
    expect(findWorkflowNote(files, 'weekly-report')).toBe(
      'Workflows/Health/Weekly Report.md',
    );
    expect(findWorkflowNote(files, 'Weekly Report')).toBe(
      'Workflows/Health/Weekly Report.md',
    );
    expect(findWorkflowNote(files, 'report')).toBeNull();
  });
});
