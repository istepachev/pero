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
import { SKELETON_NOTES } from '../config/workspace-skeleton.js';
import { parseNote } from './note.js';
import { noteIdentity } from './note-files.js';
import {
  agentNoteFor,
  createFileExclusive,
  formatNote,
  freeAgentNote,
  noteFromTemplate,
  renameTopicIn,
  setNoteProperty,
  topicNoteTitle,
} from './note-writer.js';
import { readNote } from './snapshot.js';

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
      const found = noteIdentity(`Agents/${n}.md`);
      return found.ok ? found.identity.name : null;
    };
    expect(name(title)).not.toBeNull();
    expect(name(title)).not.toBe(name(`${title} 2`));
  });
});

describe('freeAgentNote', () => {
  it('uses the title when nothing has it', () => {
    expect(freeAgentNote('Health', ['Pero.md', 'Agents/Coach.md'])).toBe(
      'Agents/Health.md',
    );
  });

  it('numbers the file past files and names that exist anywhere in Agents', () => {
    expect(freeAgentNote('Health', ['Agents/Health.md'])).toBe(
      'Agents/Health 2.md',
    );
    expect(
      freeAgentNote('Health', ['Agents/Me/health.md', 'Agents/Health 2.md']),
    ).toBe('Agents/Health 3.md');
    // A Workflow of that name is no Agent.
    expect(freeAgentNote('Health', ['Workflows/Health.md'])).toBe(
      'Agents/Health.md',
    );
  });
});

describe('agentNoteFor', () => {
  it("names the note after the Agent's name", () => {
    expect(agentNoteFor('main')).toBe('Agents/Main.md');
    expect(agentNoteFor('my-boss')).toBe('Agents/My-boss.md');
  });
});

describe('noteFromTemplate', () => {
  it("keeps the template's properties, comments, and body, and sets topics", () => {
    const { text, problem } = noteFromTemplate(
      '---\n# Coaching\nmodel: sonnet # fast\ntopics: Old\n---\nYou coach.\n',
      'Health',
    );
    expect(problem).toBeNull();
    expect(text).toBe(
      '---\n# Coaching\nmodel: sonnet # fast\ntopics:\n  - Health\n---\nYou coach.\n',
    );
  });

  it('reads back as an Agent note for the topic, from the skeleton template', () => {
    const { text } = noteFromTemplate(
      SKELETON_NOTES['Agents/_Template.md']!,
      '2026',
    );
    expect(readNote('Agents/2026.md', text).errors).toEqual([]);
    expect(roundTrip(text)).toEqual({
      properties: { topics: ['2026'] },
      body: 'You are my assistant for this topic.',
    });
    expect(text).toContain('# model: sonnet');
  });

  it('uses a template without properties as the body', () => {
    expect(noteFromTemplate('Be kind.', 'Health').text).toBe(
      '---\ntopics:\n  - Health\n---\nBe kind.\n',
    );
  });

  it('writes topics alone without a template, or with a broken one', () => {
    expect(noteFromTemplate(null, 'Health')).toEqual({
      text: '---\ntopics:\n  - Health\n---\n',
      problem: null,
    });
    const broken = noteFromTemplate('---\nmodel: [\n---\nBody', 'Health');
    expect(broken.text).toBe('---\ntopics:\n  - Health\n---\n');
    expect(broken.problem).toMatch(/^its properties don't parse/);
  });
});

describe('renameTopicIn', () => {
  const note =
    '---\n# Mine\ntopics: [Health, Sleep] # both\nmodel: sonnet\n---\n\nYou  track.\n\n';

  it('renames the title in any case, keeping comments and the body', () => {
    expect(renameTopicIn(note, 'health', 'Fitness')).toBe(
      '---\n# Mine\ntopics: [Fitness, Sleep] # both\nmodel: sonnet\n---\n\nYou  track.\n\n',
    );
  });

  it('renames a single title, quoting what needs it', () => {
    expect(
      renameTopicIn('---\ntopics: Health # me\n---\nBody', 'Health', '2026'),
    ).toBe('---\ntopics: "2026" # me\n---\nBody');
  });

  it('adds the new title after the old one when asked to keep it', () => {
    expect(
      renameTopicIn('---\ntopics:\n  - Health\n---\n', 'Health', 'Fit', true),
    ).toBe('---\ntopics:\n  - Health\n  - Fit\n---\n');
    expect(
      renameTopicIn('---\ntopics: Health\n---\n', 'Health', 'Fit', true),
    ).toBe('---\ntopics:\n  - Health\n  - Fit\n---\n');
  });

  it("is null when the note doesn't list the title or doesn't parse", () => {
    expect(renameTopicIn(note, 'Garden', 'Fitness')).toBeNull();
    expect(renameTopicIn('You track.', 'Health', 'Fitness')).toBeNull();
    expect(renameTopicIn('---\ntopics: [\n---\n', 'Health', 'Fit')).toBeNull();
  });
});

describe('createFileExclusive', () => {
  it('writes a new file, never replaces one, and leaves no temporary file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pero-note-writer-'));
    try {
      const path = join(dir, 'Agents', 'Health.md');
      expect(createFileExclusive(path, 'one')).toBe(true);
      expect(createFileExclusive(path, 'two')).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe('one');
      writeFileSync(join(dir, 'Agents', 'Sleep.md'), 'mine');
      expect(createFileExclusive(join(dir, 'Agents', 'Sleep.md'), 'x')).toBe(
        false,
      );
      expect(readdirSync(join(dir, 'Agents')).sort()).toEqual([
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
