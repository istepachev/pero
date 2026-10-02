import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_EFFORTS, CODEX_EFFORTS } from '../config/provider-options.js';
import { NOTE_PROPERTIES } from '../system-files/schemas.js';
import { agentGuide, guideFile, writeAgentGuide } from './agent-guide.js';

/** The section of `guide` under heading `### <title>`, up to the next heading. */
function section(guide: string, title: string): string {
  const start = guide.indexOf(`\n### ${title}\n`);
  expect(start, title).toBeGreaterThan(-1);
  const rest = guide.slice(start + title.length + 6);
  const end = rest.search(/\n#{2,3} /);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The property names in the first column of `text`'s table. */
function tableProperties(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .flatMap((line) =>
      [...line.split('|')[1]!.matchAll(/`([a-z-]+)`/g)].map(
        (match) => match[1]!,
      ),
    );
}

describe('the guide for Agents', () => {
  const guide = agentGuide();

  it.each([
    ['`Pero.md`', NOTE_PROPERTIES.pero],
    ['Agent notes', NOTE_PROPERTIES.agent],
    ['Workflow notes', NOTE_PROPERTIES.workflow],
  ])('lists every property of %s, and no other', (title, properties) => {
    expect(tableProperties(section(guide, title)).sort()).toEqual(
      [...properties].sort(),
    );
  });

  it("lists each provider's effort levels", () => {
    const levels = (values: readonly string[]) =>
      values.map((value) => `\`${value}\``).join(', ');
    const sentence = guide.match(
      /Claude efforts are (.+?); Codex efforts are (.+?)\./,
    );
    expect(sentence).not.toBeNull();
    const [, claude, codex] = sentence!;
    expect(claude!.replace(', and ', ', ')).toBe(levels(CLAUDE_EFFORTS));
    expect(codex!.replace(', and ', ', ')).toBe(levels(CODEX_EFFORTS));
  });
});

describe('writeAgentGuide', () => {
  let workspace: string;
  let file: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pero-guide-'));
    file = guideFile(workspace);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('is .pero/guide.md in the workspace', () => {
    expect(file).toBe(join(workspace, '.pero', 'guide.md'));
  });

  it('writes the guide, and replaces an outdated one', () => {
    const at = join(workspace, 'guide.md');
    expect(writeAgentGuide(at)).toBe(true);
    expect(readFileSync(at, 'utf8')).toBe(agentGuide());

    writeFileSync(at, '# An older guide');
    expect(writeAgentGuide(at)).toBe(true);
    expect(readFileSync(at, 'utf8')).toBe(agentGuide());
  });

  it('leaves a current guide alone', () => {
    const at = join(workspace, 'guide.md');
    writeAgentGuide(at);
    const past = new Date('2026-01-01T00:00:00Z');
    utimesSync(at, past, past);

    expect(writeAgentGuide(at)).toBe(false);
    expect(statSync(at).mtime).toEqual(past);
  });
});
