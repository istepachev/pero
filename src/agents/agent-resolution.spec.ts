import { describe, expect, it } from 'vitest';
import {
  composeInstructions,
  effectiveWorkingDirectory,
  resolveAgent,
} from './agent-resolution.js';

describe('effectiveWorkingDirectory', () => {
  const settings = { defaultWorkingDirectory: '/vault' };

  it('uses the Agent’s own folder, otherwise the default', () => {
    expect(
      effectiveWorkingDirectory({ workingDirectory: '/code' }, settings),
    ).toBe('/code');
    expect(
      effectiveWorkingDirectory({ workingDirectory: null }, settings),
    ).toBe('/vault');
  });

  it('refuses to follow an unset default', () => {
    expect(() =>
      effectiveWorkingDirectory(
        { workingDirectory: null },
        { defaultWorkingDirectory: null },
      ),
    ).toThrow(/unset/);
  });
});

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

describe('resolveAgent', () => {
  it('composes the instructions', () => {
    expect(
      resolveAgent(
        {
          name: 'coach',
          title: null,
          provider: 'codex',
          providerOptions: { model: 'gpt-5', effort: 'high' },
          permissions: 'bypass',
          workingDirectory: '/vault',
          ownWorkingDirectory: null,
          instructions: 'Track spending.',
          sharedInstructions: true,
          skipGitRepoCheck: true,
          enabled: false,
        },
        { sharedInstructions: 'Answer in English.' },
      ),
    ).toEqual({
      name: 'coach',
      provider: 'codex',
      providerOptions: { model: 'gpt-5', effort: 'high' },
      workingDirectory: '/vault',
      instructions: 'Answer in English.\n\nTrack spending.',
      toolPolicy: { permissions: 'bypass' },
      codexSkipGitRepoCheck: true,
      enabled: false,
    });
  });
});
