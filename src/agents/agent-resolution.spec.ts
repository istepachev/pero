import { describe, expect, it } from 'vitest';
import {
  composeInstructions,
  effectiveWorkingDirectory,
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
        { instructions: 'Track spending.', useSharedInstructions: true },
        shared,
      ),
    ).toBe('Answer in English.\n\nTrack spending.');
  });

  it('leaves the shared instructions out when the Agent opts out', () => {
    expect(
      composeInstructions(
        { instructions: 'Track spending.', useSharedInstructions: false },
        shared,
      ),
    ).toBe('Track spending.');
  });

  it('uses whichever part exists, and nothing when neither does', () => {
    expect(
      composeInstructions(
        { instructions: null, useSharedInstructions: true },
        shared,
      ),
    ).toBe('Answer in English.');
    expect(
      composeInstructions(
        { instructions: 'Track spending.', useSharedInstructions: true },
        { sharedInstructions: null },
      ),
    ).toBe('Track spending.');
    expect(
      composeInstructions(
        { instructions: '  ', useSharedInstructions: true },
        { sharedInstructions: '' },
      ),
    ).toBe('');
  });

  it('trims each part so they meet at one blank line', () => {
    expect(
      composeInstructions(
        { instructions: '\nTrack spending.\n', useSharedInstructions: true },
        { sharedInstructions: 'Answer in English.\n\n' },
      ),
    ).toBe('Answer in English.\n\nTrack spending.');
  });
});
