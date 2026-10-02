import type { SkeletonEntry } from '../config/workspace-skeleton.js';
import { table } from './format-status.js';

/**
 * What `pero init` wrote in `workspace`, and, unless `next` is false, how
 * to start Pero there.
 */
export function formatInit(
  result: { workspace: string; entries: SkeletonEntry[] },
  next = true,
): string {
  const { workspace, entries } = result;
  const created = entries.some((entry) => entry.action !== 'kept');
  return [
    created
      ? `Pero workspace ${workspace}:`
      : `Pero workspace ${workspace} has everything already:`,
    ...table(entries.map(({ action, path }) => [action, path])).map(
      (row) => `  ${row}`,
    ),
    ...(next ? ['', `Start Pero there with: cd ${workspace} && pero run`] : []),
  ].join('\n');
}

/** What `pero run` filled in of a workspace missing it; null when nothing. */
export function formatFilled(entries: SkeletonEntry[]): string | null {
  if (entries.length === 0) return null;
  return [
    'Filled in what the workspace was missing:',
    ...table(entries.map(({ action, path }) => [action, path])).map(
      (row) => `  ${row}`,
    ),
  ].join('\n');
}
