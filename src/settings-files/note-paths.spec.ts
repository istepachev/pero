import { describe, expect, it } from 'vitest';
import { findAgentNote, findWorkflowNote, shownPath } from './note-paths.js';

describe('note paths', () => {
  it('shows paths inside the workspace relative to it', () => {
    const workspace = '/home/me/workspace';
    expect(shownPath(workspace, `${workspace}/.pero/config.yaml`)).toBe(
      '.pero/config.yaml',
    );
    expect(shownPath(workspace, '/srv/vault/Settings/Pero.md')).toBe(
      '/srv/vault/Settings/Pero.md',
    );
  });

  it('finds an Agent note by name or title, in subfolders too', () => {
    const files = [
      'Pero.md',
      'Agents/Main.md',
      'Agents/Home/Health Coach.md',
      'Workflows/Health Coach.md',
    ];
    expect(findAgentNote(files, 'health-coach')).toBe(
      'Agents/Home/Health Coach.md',
    );
    expect(findAgentNote(files, 'Health Coach')).toBe(
      'Agents/Home/Health Coach.md',
    );
    expect(findAgentNote(files, 'MAIN')).toBe('Agents/Main.md');
    expect(findAgentNote(files, 'coach')).toBeNull();
  });

  it('finds a Workflow note by name or title, in subfolders too', () => {
    const files = [
      'Agents/Weekly Report.md',
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
