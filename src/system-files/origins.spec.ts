import { describe, expect, it } from 'vitest';
import { channelOrigins } from './origins.js';
import { buildSnapshot } from './snapshot.js';

describe('channelOrigins', () => {
  it("tells the note's values from Pero.md's and Pero's own", () => {
    const snapshot = buildSnapshot(
      [
        {
          file: 'Pero.md',
          text: '---\nprovider: codex\ncodex-effort: high\nclaude-model: opus\n---',
        },
        { file: 'Channels/Coder.md', text: '---\nmodel: gpt-5.5\n---' },
        {
          file: 'Channels/Writer.md',
          text: '---\nprovider: claude\npermissions: bypass\nworking-directory: writing\n---',
        },
      ],
      {
        workspace: '/ws',
        homeDir: '/home/me',
        hostTimeZone: 'UTC',
      },
    );
    expect(
      channelOrigins(snapshot.channelNotes.get('coder')!, snapshot.peroProperties),
    ).toEqual({
      provider: 'pero',
      model: 'note',
      effort: 'pero',
      permissions: 'default',
      workingDirectory: 'workspace',
    });
    expect(
      channelOrigins(snapshot.channelNotes.get('writer')!, snapshot.peroProperties),
    ).toEqual({
      provider: 'note',
      model: 'pero',
      effort: 'default',
      permissions: 'note',
      workingDirectory: 'note',
    });
  });
});
