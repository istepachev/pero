import { describe, expect, it } from 'vitest';
import { parseNote } from './note.js';
import { formatNote } from './note-writer.js';

function roundTrip(text: string) {
  const result = parseNote('Agents/Health.md', text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.note;
}

describe('formatNote', () => {
  it('writes properties in order, then the body', () => {
    expect(
      formatNote(
        [
          ['topics', ['Health', 'Sport']],
          ['effort', 'high'],
          ['enabled', false],
          ['hour', 9],
        ],
        '  You are my coach.\n',
      ),
    ).toBe(
      '---\ntopics:\n  - Health\n  - Sport\neffort: high\nenabled: false\nhour: 9\n---\nYou are my coach.\n',
    );
  });

  it('quotes text that YAML would read as something else', () => {
    const properties: [string, string | string[]][] = [
      ['topics', ['2026', 'true', 'null', 'a: b', '#1', 'Здоровье']],
      ['model', '5.5'],
      ['cron', '*/15 9-17 * * 1-5'],
      ['working-directory', '~/notes'],
    ];
    expect(roundTrip(formatNote(properties, 'Hi.')).properties).toEqual(
      Object.fromEntries(properties),
    );
  });

  it('writes a body alone without properties, and nothing for an empty note', () => {
    expect(formatNote([], 'Just text.')).toBe('Just text.\n');
    expect(formatNote([], null)).toBe('');
    expect(formatNote([['enabled', false]], null)).toBe(
      '---\nenabled: false\n---\n',
    );
  });

  it('keeps a body that starts with a --- line from reading as properties', () => {
    const text = formatNote([], '---\nnot: properties\n---\nText.');
    expect(roundTrip(text)).toEqual({
      properties: {},
      body: '---\nnot: properties\n---\nText.',
    });
  });
});
