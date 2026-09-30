import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The tables a legacy data directory defined its Agents, defaults, and
 * Workflows in. Runtime code reads definitions through `Definitions`; only
 * `pero migrate` and a legacy data directory's defaults read these.
 */
const LEGACY_DEFINITION_TABLES = [
  'legacy_agents',
  'legacy_settings',
  'legacy_workflows',
  'legacy_triggers',
  'legacy_workflow_notification_targets',
  'legacy_allowed_chats',
];

/** Where they may be named: their one reader, and the migrations. */
const ALLOWED = [
  /^definitions\/legacy-definitions\.ts$/,
  /^persistence\/migrations\//,
];

const TABLE_NAME = new RegExp(`"(${LEGACY_DEFINITION_TABLES.join('|')})"`);

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

describe('the legacy definition tables', () => {
  it('are read only through legacy-definitions.ts', () => {
    const offenders = sources(SRC)
      .map((path) => relative(SRC, path))
      .filter((file) => !ALLOWED.some((allowed) => allowed.test(file)))
      .filter((file) => TABLE_NAME.test(readFileSync(join(SRC, file), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('are recognised in SQL', () => {
    expect(TABLE_NAME.test(`SELECT * FROM "legacy_workflows"`)).toBe(true);
    expect(TABLE_NAME.test(`DELETE FROM "legacy_allowed_chats"`)).toBe(true);
    // State, and the Channel routes an entity maps.
    expect(TABLE_NAME.test(`SELECT * FROM "workflow_runs"`)).toBe(false);
    expect(TABLE_NAME.test(`FROM "legacy_channel_agents"`)).toBe(false);
  });
});
