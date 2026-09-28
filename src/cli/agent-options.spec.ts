import { describe, expect, it } from 'vitest';
import { agentChange, renameAgentFields } from './agent-options.js';
import { CliError } from './errors.js';

const context = {
  cwd: '/home/ada/work',
  home: '/home/ada',
  stdin: () => Promise.resolve('Be brief.\nAnswer in English.'),
};

describe('agentChange', () => {
  it('leaves out every option not given', async () => {
    expect(await agentChange({}, context)).toEqual({});
  });

  it('maps each option to its field', async () => {
    expect(
      await agentChange(
        {
          title: 'Notes',
          provider: 'codex',
          model: 'gpt-5.5',
          effort: 'high',
          workingDirectory: '~/vault',
          instructions: 'Be brief.',
          sharedInstructions: false,
          permissions: 'bypass',
          skipGitRepoCheck: true,
        },
        context,
      ),
    ).toEqual({
      title: 'Notes',
      provider: 'codex',
      providerOptions: { model: 'gpt-5.5', effort: 'high' },
      workingDirectory: '/home/ada/vault',
      instructions: 'Be brief.',
      useSharedInstructions: false,
      permissions: 'bypass',
      codexSkipGitRepoCheck: true,
    });
  });

  it('returns each --no- option to its default', async () => {
    expect(
      await agentChange(
        {
          title: false,
          model: false,
          effort: false,
          instructions: false,
          sharedInstructions: true,
          skipGitRepoCheck: false,
          followDefault: true,
        },
        context,
      ),
    ).toEqual({
      title: null,
      providerOptions: { model: null, effort: null },
      instructions: null,
      useSharedInstructions: true,
      codexSkipGitRepoCheck: false,
      workingDirectory: null,
    });
  });

  it('resolves a relative folder from the current folder', async () => {
    expect(
      await agentChange({ workingDirectory: '../notes' }, context),
    ).toEqual({ workingDirectory: '/home/ada/notes' });
  });

  it('reads instructions from stdin for -', async () => {
    expect(await agentChange({ instructions: '-' }, context)).toEqual({
      instructions: 'Be brief.\nAnswer in English.',
    });
  });

  it('refuses empty instructions and a folder with --follow-default', async () => {
    await expect(
      agentChange(
        { instructions: '-' },
        { ...context, stdin: async () => ' ' },
      ),
    ).rejects.toThrow(
      new CliError(
        'No instructions given; use --no-instructions to remove them',
      ),
    );
    await expect(
      agentChange({ workingDirectory: '/srv', followDefault: true }, context),
    ).rejects.toThrow(
      new CliError(
        'Give either --working-directory or --follow-default, not both',
      ),
    );
  });
});

describe('renameAgentFields', () => {
  it('names the options instead of the fields', () => {
    expect(
      renameAgentFields(
        'change.providerOptions.effort: Invalid option; change.provider: Invalid option',
      ),
    ).toBe('--effort: Invalid option; --provider: Invalid option');
    expect(
      renameAgentFields(
        'Invalid claude options: providerOptions.effort: Invalid option',
      ),
    ).toBe('Invalid claude options: --effort: Invalid option');
    expect(renameAgentFields('permissions: Invalid option')).toBe(
      '--permissions: Invalid option',
    );
    expect(renameAgentFields('Working directory /srv/x does not exist')).toBe(
      'Working directory /srv/x does not exist',
    );
  });
});
