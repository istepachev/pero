import type { MigrateResult } from '../migrate/migrate-installation.js';
import { formatCheck } from './format-check.js';
import { table } from './format-status.js';

/**
 * What `pero migrate` wrote, what the owner should look at, what `pero
 * check` says of the new workspace, and how to start Pero there.
 */
export function formatMigrate(source: string, result: MigrateResult): string {
  const { workspace, entries, notices, check } = result;
  const lines = [
    `Migrated data directory ${source} into workspace ${workspace}:`,
    ...table(entries.map(({ action, path }) => [action, path])).map(
      (row) => `  ${row}`,
    ),
  ];
  if (notices.length > 0) {
    lines.push('', 'Check these:', ...notices.map((notice) => `  - ${notice}`));
  }
  lines.push('', formatCheck(check), '');
  lines.push(
    check.problems.length === 0
      ? `Start Pero there with: cd ${workspace} && pero run`
      : `Fix these, then start Pero there with: cd ${workspace} && pero run`,
  );
  lines.push(
    `${source} is unchanged; Pero no longer needs it once this works.`,
  );
  return lines.join('\n');
}
