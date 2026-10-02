import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHANNEL_TEMPLATE_NOTE } from '../config/workspace-skeleton.js';
import { parseNote } from './note.js';
import { noteIdentity } from './note-files.js';
import {
  createFileExclusive,
  formatNote,
  freeChannelNote,
  noteFromTemplate,
  replaceNoteProperty,
  setNoteProperty,
  topicNoteTitle,
} from './note-writer.js';
import { readNote } from './snapshot.js';

function roundTrip(text: string) {
  const result = parseNote('Channels/Health.md', text);
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

describe('topicNoteTitle', () => {
  it('keeps a plain title', () => {
    expect(topicNoteTitle('Health', '5')).toBe('Health');
    expect(topicNoteTitle('Здоровье и сон', '5')).toBe('Здоровье и сон');
  });

  it('replaces characters file names and links do not allow', () => {
    expect(topicNoteTitle('Work/Life: 50%? <yes> "no" | #1 [a]^', '5')).toBe(
      'Work Life 50% yes no 1 a',
    );
    expect(topicNoteTitle('a\tb\nc', '5')).toBe('a b c');
  });

  it('drops what would hide the note or trouble a file system', () => {
    expect(topicNoteTitle('_Drafts', '5')).toBe('Drafts');
    expect(topicNoteTitle('.hidden.', '5')).toBe('hidden');
    expect(topicNoteTitle(' ._ Notes ', '5')).toBe('Notes');
  });

  it('falls back to the topic ID when no letter or digit is left', () => {
    expect(topicNoteTitle('🎉 !!', '12')).toBe('Topic 12');
    expect(topicNoteTitle('///', '12')).toBe('Topic 12');
  });

  it('shortens a long title so numbered names stay apart', () => {
    const title = topicNoteTitle('Щука '.repeat(40), '5');
    expect(title.length).toBeLessThanOrEqual(80);
    const name = (n: string) => {
      const found = noteIdentity(`Channels/${n}.md`);
      return found.ok ? found.identity.name : null;
    };
    expect(name(title)).not.toBeNull();
    expect(name(title)).not.toBe(name(`${title} 2`));
  });
});

describe('freeChannelNote', () => {
  it('uses the title when nothing has it', () => {
    expect(freeChannelNote('Health', ['Pero.md', 'Channels/Coach.md'])).toBe(
      'Channels/Health.md',
    );
  });

  it('numbers the file past files and names that exist anywhere in Channels', () => {
    expect(freeChannelNote('Health', ['Channels/Health.md'])).toBe(
      'Channels/Health 2.md',
    );
    expect(
      freeChannelNote('Health', [
        'Channels/Me/health.md',
        'Channels/Health 2.md',
      ]),
    ).toBe('Channels/Health 3.md');
    // A Workflow of that name is no Channel note.
    expect(freeChannelNote('Health', ['Workflows/Health.md'])).toBe(
      'Channels/Health.md',
    );
  });
});

describe('noteFromTemplate', () => {
  const ID = 'telegram:-100123:5';

  it("keeps the template's properties, comments, and body, and sets channel-id", () => {
    const { text, problem } = noteFromTemplate(
      '---\n# Coaching\nmodel: sonnet # fast\nchannel-id: old\n---\nYou coach.\n',
      ID,
    );
    expect(problem).toBeNull();
    expect(text).toBe(
      `---\n# Coaching\nmodel: sonnet # fast\nchannel-id: ${ID}\n---\nYou coach.\n`,
    );
  });

  it('reads back as a Channel note, from a commented template', () => {
    const { text } = noteFromTemplate(
      [
        '---',
        '# The starting point for the note of a new Channel.',
        '# channel-id:',
        '# model: sonnet',
        '# effort: high',
        '---',
        'You are my assistant for this topic.',
        '',
      ].join('\n'),
      ID,
    );
    expect(readNote('Channels/2026.md', text).errors).toEqual([]);
    expect(roundTrip(text)).toEqual({
      properties: { 'channel-id': ID },
      body: 'You are my assistant for this topic.',
    });
    expect(text).toContain('# model: sonnet');
  });

  it("fills in Pero's own template", () => {
    const { text, problem } = noteFromTemplate(CHANNEL_TEMPLATE_NOTE, ID);
    expect(problem).toBeNull();
    expect(readNote('Channels/Health.md', text).errors).toEqual([]);
    expect(roundTrip(text).properties).toMatchObject({ 'channel-id': ID });
  });

  it('uses a template without properties as the body', () => {
    expect(noteFromTemplate('Be kind.', ID).text).toBe(
      `---\nchannel-id: ${ID}\n---\nBe kind.\n`,
    );
  });

  it('writes channel-id alone with a broken template', () => {
    const broken = noteFromTemplate('---\nmodel: [\n---\nBody', ID);
    expect(broken.text).toBe(`---\nchannel-id: ${ID}\n---\n`);
    expect(broken.problem).toMatch(/^its properties don't parse/);
  });
});

describe('createFileExclusive', () => {
  it('writes a new file, never replaces one, and leaves no temporary file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pero-note-writer-'));
    try {
      const path = join(dir, 'Channels', 'Health.md');
      expect(createFileExclusive(path, 'one')).toBe(true);
      expect(createFileExclusive(path, 'two')).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe('one');
      writeFileSync(join(dir, 'Channels', 'Sleep.md'), 'mine');
      expect(createFileExclusive(join(dir, 'Channels', 'Sleep.md'), 'x')).toBe(
        false,
      );
      expect(readdirSync(join(dir, 'Channels')).sort()).toEqual([
        'Health.md',
        'Sleep.md',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('setNoteProperty', () => {
  it('turns a commented-out line into the property, keeping its comment column', () => {
    const text =
      '---\n# provider: claude            # claude or codex\n# permissions: ask\n---\nBe kind.\n';

    expect(setNoteProperty(text, 'provider', 'codex')).toBe(
      '---\nprovider: codex               # claude or codex\n# permissions: ask\n---\nBe kind.\n',
    );
    expect(
      setNoteProperty('---\n# provider: claude\n---\n', 'provider', 'codex'),
    ).toBe('---\nprovider: codex\n---\n');
  });

  it('adds the property when no line mentions it', () => {
    expect(
      setNoteProperty(
        '---\n# A comment\ntimezone: UTC\n---\nBody\n',
        'provider',
        'codex',
      ),
    ).toBe('---\n# A comment\ntimezone: UTC\nprovider: codex\n---\nBody\n');
    expect(setNoteProperty('Body\n', 'provider', 'codex')).toBe(
      '---\nprovider: codex\n---\nBody\n',
    );
  });

  it('leaves a note that sets it, or does not parse, alone', () => {
    expect(
      setNoteProperty('---\nprovider: claude\n---\n', 'provider', 'codex'),
    ).toBeNull();
    expect(
      setNoteProperty('---\nprovider: [\n---\n', 'provider', 'codex'),
    ).toBeNull();
  });
});

describe('replaceNoteProperty', () => {
  const note =
    '---\ntopic: Running   # the topic\nmodel: sonnet  # cheaper\n# effort: high\n---\nYou coach.\n';

  it('replaces a value, keeping comments and the body', () => {
    expect(replaceNoteProperty(note, 'model', 'opus')).toBe(
      '---\ntopic: Running   # the topic\nmodel: opus    # cheaper\n# effort: high\n---\nYou coach.\n',
    );
    expect(replaceNoteProperty(note, 'model', 'claude-opus-4-8[1m]')).toContain(
      '\nmodel: claude-opus-4-8[1m] # cheaper\n',
    );
  });

  it('fills in an empty property, keeping its comment in its column', () => {
    expect(
      replaceNoteProperty(
        '---\nprovider:                     # claude or codex\n---\n',
        'provider',
        'codex',
      ),
    ).toBe('---\nprovider: codex               # claude or codex\n---\n');
  });

  it('adds a property as setNoteProperty does, from its commented line', () => {
    expect(replaceNoteProperty(note, 'effort', 'low')).toBe(
      '---\ntopic: Running   # the topic\nmodel: sonnet  # cheaper\neffort: low\n---\nYou coach.\n',
    );
    expect(replaceNoteProperty('You coach.\n', 'model', 'opus')).toBe(
      '---\nmodel: opus\n---\nYou coach.\n',
    );
  });

  it('removes a property, and leaves a note without it as it is', () => {
    expect(replaceNoteProperty(note, 'model', null)).toBe(
      '---\ntopic: Running   # the topic\n# effort: high\n---\nYou coach.\n',
    );
    expect(replaceNoteProperty(note, 'permissions', null)).toBe(note);
    expect(replaceNoteProperty('Body\n', 'model', null)).toBe('Body\n');
  });

  it('quotes a value that would read as something else', () => {
    for (const value of ['5.5', 'true', 'a: b', '#1']) {
      const text = replaceNoteProperty('---\ntopic: X\n---\n', 'model', value)!;
      expect(parseNote('Agents/X.md', text)).toMatchObject({
        ok: true,
        note: { properties: { model: value } },
      });
    }
  });

  it('goes through the YAML document for a value over several lines', () => {
    const text = replaceNoteProperty(
      '---\nmodel: >\n  long\n  name\ntopic: X\n---\n',
      'model',
      'opus',
    )!;

    expect(parseNote('Agents/X.md', text)).toMatchObject({
      ok: true,
      note: { properties: { model: 'opus', topic: 'X' } },
    });
  });

  it("leaves a note whose properties don't parse alone", () => {
    expect(
      replaceNoteProperty('---\nmodel: [\n---\n', 'model', 'opus'),
    ).toBeNull();
  });
});
