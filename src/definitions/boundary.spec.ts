import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The entities that hold definitions, which runtime code reads through `Definitions`. */
const DEFINITION_ENTITIES = [
  'agent',
  'settings',
  'workflow',
  'trigger',
  'workflow-notification-target',
];

/** Where definition entities may be imported: their store and their writers. */
const ALLOWED = [
  /^definitions\//,
  /^persistence\//,
  // The create and edit services write the tables.
  /^agents\/agents\.service\.ts$/,
  /^settings\/settings\.service\.ts$/,
  /^workflows\/workflows\.service\.ts$/,
  /^triggers\/triggers\.service\.ts$/,
];

const ENTITY_IMPORT = new RegExp(
  `from '[./]*/(?:persistence/)?entities/(${DEFINITION_ENTITIES.join('|')})\\.entity\\.js'`,
);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'testing' ? [] : sources(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
      ? [path]
      : [];
  });
}

describe('definition entities', () => {
  it('are imported only by Definitions, persistence, and the edit services', () => {
    const offenders = sources(SRC)
      .map((path) => relative(SRC, path))
      .filter((file) => !ALLOWED.some((allowed) => allowed.test(file)))
      .filter((file) =>
        ENTITY_IMPORT.test(readFileSync(join(SRC, file), 'utf8')),
      );
    expect(offenders).toEqual([]);
  });

  it('are recognised however the import is written', () => {
    expect(
      ENTITY_IMPORT.test(`} from '../persistence/entities/agent.entity.js';`),
    ).toBe(true);
    expect(
      ENTITY_IMPORT.test(`import { Workflow } from './workflow.entity.js';`),
    ).toBe(false);
    expect(
      ENTITY_IMPORT.test(
        `from '../../persistence/entities/settings.entity.js'`,
      ),
    ).toBe(true);
    expect(
      ENTITY_IMPORT.test(
        `from '../persistence/entities/workflow-notification-target.entity.js'`,
      ),
    ).toBe(true);
    expect(
      ENTITY_IMPORT.test(
        `from '../persistence/entities/workflow-run.entity.js'`,
      ),
    ).toBe(false);
  });
});
