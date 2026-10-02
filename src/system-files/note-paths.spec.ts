import { describe, expect, it } from 'vitest';
import { findWorkflowNote, shownPath } from './note-paths.js';

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
