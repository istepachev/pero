import { describe, expect, it } from 'vitest';
import type { Agent } from '../settings-files/snapshot.js';
import {
  agentRequest,
  composeInstructions,
  dataFolderNote,
} from './agent-request.js';

const DATA = dataFolderNote('/ws/data');

describe('composeInstructions', () => {
  const shared = {
    dataFolder: '/ws/data',
    sharedInstructions: 'Answer in English.',
  };

  it('names the data folder, then the shared instructions, then the Agent’s own', () => {
    expect(
      composeInstructions(
        { instructions: 'Track spending.', sharedInstructions: true },
        shared,
      ),
    ).toBe(`${DATA}\n\nAnswer in English.\n\nTrack spending.`);
    expect(DATA).toContain('/ws/data');
  });

  it('leaves the shared instructions out when the Agent opts out', () => {
    expect(
      composeInstructions(
        { instructions: 'Track spending.', sharedInstructions: false },
        shared,
      ),
    ).toBe(`${DATA}\n\nTrack spending.`);
  });

  it('leaves out empty parts, keeping the data folder', () => {
    expect(
      composeInstructions(
        { instructions: null, sharedInstructions: true },
        shared,
      ),
    ).toBe(`${DATA}\n\nAnswer in English.`);
    expect(
      composeInstructions(
        { instructions: 'Track spending.', sharedInstructions: true },
        { dataFolder: '/ws/data', sharedInstructions: null },
      ),
    ).toBe(`${DATA}\n\nTrack spending.`);
    expect(
      composeInstructions(
        { instructions: '  ', sharedInstructions: true },
        { dataFolder: '/ws/data', sharedInstructions: '' },
      ),
    ).toBe(DATA);
  });

  it('trims each part so they meet at one blank line', () => {
    expect(
      composeInstructions(
        { instructions: '\nTrack spending.\n', sharedInstructions: true },
        {
          dataFolder: '/ws/data',
          sharedInstructions: 'Answer in English.\n\n',
        },
      ),
    ).toBe(`${DATA}\n\nAnswer in English.\n\nTrack spending.`);
  });
});

describe('agentRequest', () => {
  it("maps the Agent's settings and composes the instructions", () => {
    const note: Agent['note'] = {
      topics: [],
      provider: 'codex',
      model: 'gpt-5',
      effort: 'high',
      permissions: 'bypass',
      workingDirectory: null,
      sharedInstructions: true,
      skipGitRepoCheck: true,
      enabled: false,
      instructions: 'Track spending.',
    };
    const agent: Agent = {
      name: 'coach',
      title: 'Coach',
      file: 'Agents/Coach.md',
      topics: [],
      provider: 'codex',
      model: 'gpt-5',
      effort: 'high',
      permissions: 'bypass',
      workingDirectory: '/vault',
      sharedInstructions: true,
      skipGitRepoCheck: true,
      enabled: false,
      instructions: 'Track spending.',
      note,
    };
    expect(
      agentRequest(agent, {
        dataFolder: '/vault',
        sharedInstructions: 'Answer in English.',
      }),
    ).toEqual({
      instructions: `${dataFolderNote('/vault')}\n\nAnswer in English.\n\nTrack spending.`,
      providerOptions: { model: 'gpt-5', effort: 'high' },
      workingDirectory: '/vault',
      skipGitRepoCheck: true,
      toolPolicy: { permissions: 'bypass' },
    });
  });
});
