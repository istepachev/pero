import { describe, expect, it } from 'vitest';
import { parseNote } from './note.js';

const FILE = 'Agents/Health.md';

function parsed(text: string) {
  const result = parseNote(FILE, text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.note;
}

function errors(text: string) {
  const result = parseNote(FILE, text);
  if (result.ok) throw new Error('expected errors');
  return result.errors;
}

describe('parseNote', () => {
  it('splits frontmatter from the body', () => {
    expect(
      parsed(
        '---\ntopic: Health\neffort: high\n---\nYou are my health coach.\n',
      ),
    ).toEqual({
      properties: { topic: 'Health', effort: 'high' },
      body: 'You are my health coach.',
    });
  });

  it('accepts an empty note', () => {
    expect(parsed('')).toEqual({ properties: {}, body: null });
    expect(parsed('\n  \n')).toEqual({ properties: {}, body: null });
  });

  it('accepts frontmatter without a body', () => {
    expect(parsed('---\nprovider: codex\n---\n')).toEqual({
      properties: { provider: 'codex' },
      body: null,
    });
    expect(parsed('---\nprovider: codex\n---')).toEqual({
      properties: { provider: 'codex' },
      body: null,
    });
  });

  it('accepts empty frontmatter', () => {
    expect(parsed('---\n---\nHello')).toEqual({
      properties: {},
      body: 'Hello',
    });
    expect(parsed('---\n# only a comment\n---\nHello')).toEqual({
      properties: {},
      body: 'Hello',
    });
  });

  it('reads a note without frontmatter as all body', () => {
    expect(parsed('You help with everyday questions.\n')).toEqual({
      properties: {},
      body: 'You help with everyday questions.',
    });
  });

  it('takes --- only on the first line as frontmatter', () => {
    const text = '\n---\nprovider: codex\n---\nHello';
    expect(parsed(text)).toEqual({ properties: {}, body: text.trim() });
    expect(parsed('Intro\n---\nMore').body).toBe('Intro\n---\nMore');
  });

  it('keeps --- lines inside the body', () => {
    expect(parsed('---\na: 1\n---\nOne\n---\nTwo').body).toBe('One\n---\nTwo');
  });

  it('tolerates a byte order mark, CRLF line ends, and trailing spaces', () => {
    expect(
      parsed('﻿---  \r\nprovider: codex\r\n---\r\nLine one\r\nLine two'),
    ).toEqual({
      properties: { provider: 'codex' },
      body: 'Line one\nLine two',
    });
  });

  it('reads YAML 1.2, where times and yes stay strings', () => {
    expect(
      parsed('---\nat: 12:00\nflag: yes\nhour: 09\ncount: 3\non: true\n---')
        .properties,
    ).toEqual({ at: '12:00', flag: 'yes', hour: 9, count: 3, on: true });
  });

  it('reads dates as strings', () => {
    expect(parsed('---\nsince: 2026-01-01\n---').properties).toEqual({
      since: '2026-01-01',
    });
  });

  it('refuses frontmatter with no closing line', () => {
    expect(errors('---\nprovider: codex\nHello')).toEqual([
      {
        file: FILE,
        property: null,
        message: 'the properties that start on line 1 have no closing --- line',
      },
    ]);
  });

  it('refuses frontmatter that is not a mapping', () => {
    for (const text of ['---\n- a\n- b\n---', '---\njust text\n---']) {
      expect(errors(text)).toEqual([
        {
          file: FILE,
          property: null,
          message: 'properties must be "name: value" lines',
        },
      ]);
    }
  });

  it('reports YAML errors with their line in the note', () => {
    expect(errors('---\nprovider: codex\nprovider: claude\n---')).toEqual([
      {
        file: FILE,
        property: null,
        message: expect.stringMatching(/^line 3: Map keys must be unique/),
      },
    ]);
    expect(errors('---\na: 1\ntopic: [Health\n---')).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/^line \d+: /),
      }),
    ]);
    expect(errors('---\nmodel: "opus\n---')[0]!.message).toMatch(
      /^line 2: Missing closing "quote/,
    );
  });

  it('reports an alias without an anchor', () => {
    expect(errors('---\nmodel: *other\n---')).toEqual([
      expect.objectContaining({
        property: null,
        message: expect.stringMatching(/other/),
      }),
    ]);
  });
});
