import { describe, expect, it } from 'vitest';
import { topicReply } from './topic-reply.js';

describe('topicReply', () => {
  it('extracts valid standalone names, including Russian, and deduplicates them', () => {
    expect(
      topicReply(
        'Confirm below.\n<topic> Задачи </topic>\n<topic>Задачи</topic>',
      ),
    ).toEqual({ text: 'Confirm below.', names: ['Задачи'] });
  });
  it('leaves code examples, quotes and invalid names as text', () => {
    const text =
      '```xml\n<topic>Example</topic>\n```\n> <topic>Quoted</topic>\n<topic></topic>\n<topic>' +
      'a'.repeat(129) +
      '</topic>';
    expect(topicReply(text)).toEqual({ text, names: [] });
  });
  it('limits each answer to three proposals', () => {
    const reply = topicReply(
      '<topic>A</topic>\n<topic>B</topic>\n<topic>C</topic>\n<topic>D</topic>',
    );
    expect(reply.names).toEqual(['A', 'B', 'C']);
    expect(reply.text).toBe('<topic>D</topic>');
  });
});
