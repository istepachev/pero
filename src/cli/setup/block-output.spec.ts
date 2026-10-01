import { describe, expect, it } from 'vitest';
import type { Prompts } from '../prompts.js';
import { BlockOutput } from './block-output.js';

describe('BlockOutput', () => {
  it('puts an empty line between blocks, never first or twice', () => {
    const written: string[] = [];
    const output = new BlockOutput((text) => written.push(text));

    output.block();
    output.print('one');
    output.print('two');
    output.block();
    output.block();
    output.print('three');

    expect(written).toEqual(['one', 'two', '', 'three']);
  });

  it('counts a question as output of its block', async () => {
    const written: string[] = [];
    const output = new BlockOutput((text) => written.push(text));
    const asked = (message: string) => {
      written.push(`? ${message}`);
      return Promise.resolve(true);
    };
    const prompts = output.prompts({
      confirm: ({ message }) => asked(message),
    } as Prompts);

    await prompts.confirm({ message: 'Create it?' });
    output.block();
    await prompts.confirm({ message: 'Install it?' });
    output.print('Installed');

    expect(written).toEqual(['? Create it?', '', '? Install it?', 'Installed']);
  });
});
