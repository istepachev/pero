import { describe, expect, it } from 'vitest';
import type { Agent } from '../settings-files/snapshot.js';
import {
  agentContext,
  agentRequest,
  composeInstructions,
  dataFolderNote,
  settingsNote,
} from './agent-request.js';

const FOLDERS = {
  dataFolder: '/ws/data',
  settingsFolder: '/ws/data/Settings',
  guideFile: '/ws/.pero/guide.md',
};
const HEALTH = { title: 'Health', file: 'Agents/Health.md' };
const CONTEXT = agentContext(HEALTH, FOLDERS);

describe('composeInstructions', () => {
  const main = { ...FOLDERS, mainInstructions: 'Answer in English.' };

  it('starts with the context, then the main Agent’s instructions, then its own', () => {
    expect(
      composeInstructions(
        {
          ...HEALTH,
          instructions: 'Track spending.',
          mainInstructions: true,
        },
        main,
      ),
    ).toBe(`${CONTEXT}\n\nAnswer in English.\n\nTrack spending.`);
    expect(CONTEXT).toBe(
      `${dataFolderNote('/ws/data')}\n\n${settingsNote(HEALTH, FOLDERS)}`,
    );
  });

  it('leaves the main Agent’s instructions out for the main Agent or one that opts out', () => {
    expect(
      composeInstructions(
        {
          ...HEALTH,
          instructions: 'Track spending.',
          mainInstructions: false,
        },
        main,
      ),
    ).toBe(`${CONTEXT}\n\nTrack spending.`);
  });

  it('leaves out empty parts, keeping the context', () => {
    expect(
      composeInstructions(
        { ...HEALTH, instructions: null, mainInstructions: true },
        main,
      ),
    ).toBe(`${CONTEXT}\n\nAnswer in English.`);
    expect(
      composeInstructions(
        {
          ...HEALTH,
          instructions: 'Track spending.',
          mainInstructions: true,
        },
        { ...FOLDERS, mainInstructions: null },
      ),
    ).toBe(`${CONTEXT}\n\nTrack spending.`);
    expect(
      composeInstructions(
        { ...HEALTH, instructions: '  ', mainInstructions: true },
        { ...FOLDERS, mainInstructions: '' },
      ),
    ).toBe(CONTEXT);
  });

  it('trims each part so they meet at one blank line', () => {
    expect(
      composeInstructions(
        {
          ...HEALTH,
          instructions: '\nTrack spending.\n',
          mainInstructions: true,
        },
        { ...FOLDERS, mainInstructions: 'Answer in English.\n\n' },
      ),
    ).toBe(`${CONTEXT}\n\nAnswer in English.\n\nTrack spending.`);
  });
});

describe('settingsNote', () => {
  it('names the Agent, its note, Pero.md, the Workflows, and the guide', () => {
    const note = settingsNote(
      { title: 'Weekly Health', file: 'Agents/Coaches/Weekly Health.md' },
      FOLDERS,
    );
    expect(note).toContain('the Agent Weekly Health of Pero');
    expect(note).toContain(
      'the note /ws/data/Settings/Agents/Coaches/Weekly Health.md.',
    );
    expect(note).toContain('/ws/data/Settings/Pero.md');
    expect(note).toContain('notes in /ws/data/Settings/Workflows.');
    expect(note).toMatch(/read \/ws\/\.pero\/guide\.md\.$/);
  });
});

describe('agentRequest', () => {
  it("maps the Agent's settings and composes the instructions", () => {
    const note: Agent['note'] = {
      topic: null,
      provider: 'codex',
      model: 'gpt-5',
      effort: 'high',
      permissions: 'bypass',
      workingDirectory: null,
      skipMainInstructions: false,
      skipGitRepoCheck: true,
      enabled: false,
      instructions: 'Track spending.',
    };
    const agent: Agent = {
      name: 'coach',
      title: 'Coach',
      file: 'Agents/Coach.md',
      topic: null,
      provider: 'codex',
      model: 'gpt-5',
      effort: 'high',
      permissions: 'bypass',
      workingDirectory: '/vault',
      mainInstructions: true,
      skipGitRepoCheck: true,
      enabled: false,
      instructions: 'Track spending.',
      note,
    };
    const folders = {
      dataFolder: '/vault',
      settingsFolder: '/vault/Settings',
      guideFile: '/ws/.pero/guide.md',
    };
    expect(
      agentRequest(agent, {
        ...folders,
        mainInstructions: 'Answer in English.',
      }),
    ).toEqual({
      instructions: `${agentContext(agent, folders)}\n\nAnswer in English.\n\nTrack spending.`,
      providerOptions: { model: 'gpt-5', effort: 'high' },
      workingDirectory: '/vault',
      skipGitRepoCheck: true,
      toolPolicy: { permissions: 'bypass' },
    });
  });
});
