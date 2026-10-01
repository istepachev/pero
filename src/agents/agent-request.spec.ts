import { describe, expect, it } from 'vitest';
import type { Agent } from '../settings-files/snapshot.js';
import { agentRequest, composeInstructions } from './agent-request.js';

describe('composeInstructions', () => {
  const shared = { sharedInstructions: 'Answer in English.' };

  it('puts the shared instructions before the Agent’s own', () => {
    expect(
      composeInstructions(
        { instructions: 'Track spending.', sharedInstructions: true },
        shared,
      ),
    ).toBe('Answer in English.\n\nTrack spending.');
  });

  it('leaves the shared instructions out when the Agent opts out', () => {
    expect(
      composeInstructions(
        { instructions: 'Track spending.', sharedInstructions: false },
        shared,
      ),
    ).toBe('Track spending.');
  });

  it('uses whichever part exists, and nothing when neither does', () => {
    expect(
      composeInstructions(
        { instructions: null, sharedInstructions: true },
        shared,
      ),
    ).toBe('Answer in English.');
    expect(
      composeInstructions(
        { instructions: 'Track spending.', sharedInstructions: true },
        { sharedInstructions: null },
      ),
    ).toBe('Track spending.');
    expect(
      composeInstructions(
        { instructions: '  ', sharedInstructions: true },
        { sharedInstructions: '' },
      ),
    ).toBe('');
  });

  it('trims each part so they meet at one blank line', () => {
    expect(
      composeInstructions(
        { instructions: '\nTrack spending.\n', sharedInstructions: true },
        { sharedInstructions: 'Answer in English.\n\n' },
      ),
    ).toBe('Answer in English.\n\nTrack spending.');
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
      agentRequest(agent, { sharedInstructions: 'Answer in English.' }),
    ).toEqual({
      instructions: 'Answer in English.\n\nTrack spending.',
      providerOptions: { model: 'gpt-5', effort: 'high' },
      workingDirectory: '/vault',
      skipGitRepoCheck: true,
      toolPolicy: { permissions: 'bypass' },
    });
  });
});
