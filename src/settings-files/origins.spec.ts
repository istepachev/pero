import { describe, expect, it } from 'vitest';
import { agentOrigins } from './origins.js';
import { buildSnapshot } from './snapshot.js';

describe('agentOrigins', () => {
  it("tells the note's values from Pero.md's and Pero's own", () => {
    const snapshot = buildSnapshot(
      [
        {
          file: 'Pero.md',
          text: '---\nprovider: codex\ncodex-effort: high\nclaude-model: opus\n---',
        },
        { file: 'Agents/Coder.md', text: '---\nmodel: gpt-5.5\n---' },
        {
          file: 'Agents/Writer.md',
          text: '---\nprovider: claude\npermissions: bypass\nworking-directory: writing\n---',
        },
      ],
      {
        workspace: '/ws',
        dataFolder: '/ws/data',
        homeDir: '/home/me',
        hostTimeZone: 'UTC',
      },
    );
    expect(
      agentOrigins(snapshot.agents.get('coder')!, snapshot.peroProperties),
    ).toEqual({
      provider: 'pero',
      model: 'note',
      effort: 'pero',
      permissions: 'default',
      workingDirectory: 'data',
    });
    expect(
      agentOrigins(snapshot.agents.get('writer')!, snapshot.peroProperties),
    ).toEqual({
      provider: 'note',
      model: 'pero',
      effort: 'default',
      permissions: 'note',
      workingDirectory: 'note',
    });
  });
});
