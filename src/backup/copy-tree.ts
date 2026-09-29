import { constants } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** What `copyTree` did: files copied, and files kept because one was there. */
export interface CopyTreeResult {
  copied: number;
  kept: number;
}

/**
 * Copies the regular files and folders under `from` into `to`, creating
 * folders as needed and never overwriting: a file already at `to` is kept
 * and counted. Links and other special files are skipped, and so are the
 * absolute paths in `skip`. A file that disappears while copying is skipped
 * too, since `from` may be a folder in use.
 */
export async function copyTree(
  from: string,
  to: string,
  skip: ReadonlySet<string> = new Set(),
): Promise<CopyTreeResult> {
  const result: CopyTreeResult = { copied: 0, kept: 0 };
  await copyFolder(from, to, skip, result);
  return result;
}

async function copyFolder(
  from: string,
  to: string,
  skip: ReadonlySet<string>,
  result: CopyTreeResult,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(from, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    await mkdir(to, { recursive: true });
  } catch (error) {
    // A file where the folder would go: what it holds is kept, not merged.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    result.kept += 1;
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const source = join(from, entry.name);
    if (skip.has(source)) continue;
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      await copyFolder(source, target, skip, result);
    } else if (entry.isFile()) {
      try {
        await copyFile(source, target, constants.COPYFILE_EXCL);
        result.copied += 1;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') result.kept += 1;
        else if (code !== 'ENOENT') throw error;
      }
    }
  }
}
