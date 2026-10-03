import { describe, expect, it } from 'vitest';
import { answerParts, hasVoice } from './voice-reply.js';

describe('answerParts', () => {
  it('keeps an answer without voice blocks as one text', () => {
    expect(answerParts('Done. See Health/Log.md.')).toEqual([
      { kind: 'text', text: 'Done. See Health/Log.md.' },
    ]);
    expect(hasVoice('Done.')).toBe(false);
  });

  it('splits text and voice blocks, in order and trimmed', () => {
    const answer = [
      "Here's your brief:",
      '',
      '<voice>',
      '  Good morning. You have two meetings today.  ',
      '</voice>',
      '',
      '',
      '',
      'Details are in Daily/2026-10-03.md.',
      '<VOICE>Have a good day.</VOICE>',
    ].join('\n');

    expect(answerParts(answer)).toEqual([
      { kind: 'text', text: "Here's your brief:" },
      { kind: 'voice', text: 'Good morning. You have two meetings today.' },
      { kind: 'text', text: 'Details are in Daily/2026-10-03.md.' },
      { kind: 'voice', text: 'Have a good day.' },
    ]);
    expect(hasVoice(answer)).toBe(true);
  });

  it('leaves out empty blocks and empty text between blocks', () => {
    expect(answerParts('<voice> </voice>\n<voice>Hi.</voice>')).toEqual([
      { kind: 'voice', text: 'Hi.' },
    ]);
  });

  it('takes a block inside code as text', () => {
    const answer = [
      'Write `<voice>words</voice>` to send a voice message:',
      '```',
      '<voice>Hello</voice>',
      '```',
    ].join('\n');

    expect(answerParts(answer)).toEqual([{ kind: 'text', text: answer }]);
  });

  it('takes an unclosed block as text', () => {
    expect(answerParts('<voice>Hello')).toEqual([
      { kind: 'text', text: '<voice>Hello' },
    ]);
  });
});
