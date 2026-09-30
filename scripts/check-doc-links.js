#!/usr/bin/env node
// Checks that every relative link in the committed Markdown files resolves:
// the file or folder exists, and a `#fragment` names a heading in it.
// Usage: node scripts/check-doc-links.js
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const files = execFileSync('git', ['ls-files', '--', '*.md'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  // Notes of the example workspace are configuration, not docs.
  .filter((file) => !file.startsWith('examples/workspace/data/'));

/** The file's text without fenced code blocks and inline code. */
function prose(text) {
  return text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

/** GitHub's anchor for a heading: lowercase, punctuation dropped. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

const anchorCache = new Map();

/** The anchors of the headings in Markdown file `path`. */
function anchors(path) {
  let found = anchorCache.get(path);
  if (found !== undefined) return found;
  found = new Set();
  const counts = new Map();
  const text = readFileSync(path, 'utf8').replace(
    /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm,
    '',
  );
  for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(match[1].replace(/`/g, ''));
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    found.add(seen === 0 ? base : `${base}-${seen}`);
  }
  anchorCache.set(path, found);
  return found;
}

const problems = [];
for (const file of files) {
  const path = join(root, file);
  const text = prose(readFileSync(path, 'utf8'));
  for (const match of text.matchAll(
    /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g,
  )) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto:
    const [pathPart, fragment] = target.split('#', 2);
    const destination =
      pathPart === '' ? path : resolve(dirname(path), decodeURI(pathPart));
    if (!existsSync(destination)) {
      problems.push(`${file}: ${target}: no such file`);
      continue;
    }
    if (fragment === undefined || fragment === '') continue;
    if (statSync(destination).isDirectory() || !destination.endsWith('.md')) {
      continue;
    }
    if (!anchors(destination).has(fragment)) {
      problems.push(
        `${file}: ${target}: no heading #${fragment} in ${relative(root, destination)}`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} broken link(s).`);
  process.exit(1);
}
console.log(`Checked the links in ${files.length} Markdown files.`);
