import { describe, expect, it } from 'vitest';
import type { ChannelNote } from '../system-files/snapshot.js';
import {
  agentContext,
  VOICE_NOTE,
  agentRequest,
  composeInstructions,
  dataFolderNote,
  systemFolderNote,
} from './agent-request.js';

const FOLDERS = {
  dataFolder: '/ws/data',
  systemFolder: '/ws/data/System',
  guideFile: '/ws/.pero/guide.md',
};
const HEALTH = { title: 'Health', file: 'Channels/Health.md' };
const CONTEXT = agentContext(HEALTH, FOLDERS);

describe('composeInstructions', () => {
  const shared = {
    ...FOLDERS,
    persona: 'Be calm.',
    instructions: 'Answer in English.',
  };

  it('starts with the context, then the persona, the instructions, and the note’s own', () => {
    expect(
      composeInstructions(
        { ...HEALTH, instructions: 'Track spending.' },
        shared,
      ),
    ).toBe(`${CONTEXT}\n\nBe calm.\n\nAnswer in English.\n\nTrack spending.`);
    expect(CONTEXT).toBe(
      `${dataFolderNote('/ws/data')}\n\n${systemFolderNote(HEALTH, FOLDERS)}`,
    );
  });

  it('leaves out empty parts, keeping the context', () => {
    expect(composeInstructions({ ...HEALTH, instructions: null }, shared)).toBe(
      `${CONTEXT}\n\nBe calm.\n\nAnswer in English.`,
    );
    expect(
      composeInstructions(
        { ...HEALTH, instructions: 'Track spending.' },
        { ...FOLDERS, persona: null, instructions: null },
      ),
    ).toBe(`${CONTEXT}\n\nTrack spending.`);
    expect(
      composeInstructions(
        { ...HEALTH, instructions: '  ' },
        { ...FOLDERS, persona: '', instructions: '\n' },
      ),
    ).toBe(CONTEXT);
  });

  it('trims each part so they meet at one blank line', () => {
    expect(
      composeInstructions(
        { ...HEALTH, instructions: '\nTrack spending.\n' },
        { ...FOLDERS, persona: null, instructions: 'Answer in English.\n\n' },
      ),
    ).toBe(`${CONTEXT}\n\nAnswer in English.\n\nTrack spending.`);
  });
});

describe('agentContext', () => {
  it('says how to send a voice message only when Pero can record one', () => {
    expect(CONTEXT).not.toContain('<voice>');
    expect(agentContext(HEALTH, { ...FOLDERS, voice: true })).toBe(
      `${CONTEXT}\n\n${VOICE_NOTE}`,
    );
    expect(VOICE_NOTE).toContain('<voice>…</voice>');
  });
});

describe('systemFolderNote', () => {
  it('names the Channel, its note, the shared notes, the Workflows, and the guide', () => {
    const note = systemFolderNote(
      { title: 'Weekly Health', file: 'Channels/Coaches/Weekly Health.md' },
      FOLDERS,
    );
    expect(note).toContain('You are Pero');
    expect(note).toContain('the Channel Weekly Health.');
    expect(note).toContain(
      'the note /ws/data/System/Channels/Coaches/Weekly Health.md.',
    );
    expect(note).toContain('/ws/data/System/Persona.md');
    expect(note).toContain('/ws/data/System/Instructions.md');
    expect(note).toContain('/ws/data/System/Pero.md');
    expect(note).toContain('notes in /ws/data/System/Workflows.');
    expect(note).toMatch(/read \/ws\/\.pero\/guide\.md\.$/);
  });

  it('says where the note goes for a Channel without one', () => {
    expect(
      systemFolderNote({ title: 'Garden', file: null }, FOLDERS),
    ).toContain(
      'This Channel has no note of its own yet; Pero writes one in /ws/data/System/Channels.',
    );
  });
});

describe('agentRequest', () => {
  it("maps the note's settings and composes the instructions", () => {
    const note: ChannelNote['note'] = {
      channelId: null,
      provider: 'codex',
      model: 'gpt-5',
      effort: 'high',
      permissions: 'bypass',
      workingDirectory: null,
      skipGitRepoCheck: true,
      enabled: false,
      instructions: 'Track spending.',
    };
    const channel: ChannelNote = {
      name: 'coach',
      title: 'Coach',
      file: 'Channels/Coach.md',
      channelId: null,
      provider: 'codex',
      model: 'gpt-5',
      effort: 'high',
      permissions: 'bypass',
      workingDirectory: '/vault',
      skipGitRepoCheck: true,
      enabled: false,
      instructions: 'Track spending.',
      note,
    };
    const folders = {
      dataFolder: '/vault',
      systemFolder: '/vault/System',
      guideFile: '/ws/.pero/guide.md',
    };
    expect(
      agentRequest(channel, {
        ...folders,
        persona: null,
        instructions: 'Answer in English.',
      }),
    ).toEqual({
      instructions: `${agentContext(channel, folders)}\n\nAnswer in English.\n\nTrack spending.`,
      providerOptions: { model: 'gpt-5', effort: 'high' },
      workingDirectory: '/vault',
      skipGitRepoCheck: true,
      toolPolicy: { permissions: 'bypass' },
    });
  });
});
