/*
 * An agent's Markdown as Telegram shows it: the HTML subset of the Bot API's
 * `parse_mode: 'HTML'`. Pure, so the rules are tested without an adapter.
 *
 * Shown as formatting: **bold** and __bold__, *italic* and _italic_,
 * ~~strikethrough~~, ||spoiler||, `code`, fenced code blocks, [links](url),
 * and > quotes. Telegram has no headings, so a heading is a bold line, and
 * a `-`, `*`, or `+` list item starts with a bullet. It has no tables
 * either, so a table is rendered as `renderTables` says. Anything else is
 * shown as it is written. Emphasis never spans lines, so every tag closes
 * on the line it opens on, and the HTML is always well formed.
 */

import { closesFence, FENCE, renderTables } from './markdown-tables.js';
import { splitText, TELEGRAM_TEXT_LIMIT } from './split-text.js';

const QUOTE = /^ {0,3}> ?(.*)$/;
const HEADING = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LINK =
  /^\[([^\]\n]+)\]\(\s*<?((?:https?|tg|mailto):[^\s()<>]+)>?(?:\s+"[^"\n]*")?\s*\)/i;
/** A code block's language as Telegram takes it in a class name. */
const LANGUAGE = /^[\w+#.-]+$/;

/** The delimiters of emphasis, longest first so `**` is never two `*`. */
const EMPHASIS: readonly { marker: string; tag: string; inWord: boolean }[] = [
  { marker: '**', tag: 'b', inWord: true },
  { marker: '__', tag: 'b', inWord: false },
  { marker: '~~', tag: 's', inWord: true },
  { marker: '||', tag: 'tg-spoiler', inWord: true },
  { marker: '*', tag: 'i', inWord: true },
  { marker: '_', tag: 'i', inWord: false },
];

/** `markdown` as Telegram HTML. */
export function markdownToTelegramHtml(markdown: string): string {
  const lines = renderTables(markdown).markdown.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      const [, marker, language] = fence;
      const body: string[] = [];
      for (i++; i < lines.length && !closesFence(lines[i]!, marker!); i++) {
        body.push(lines[i]!);
      }
      out.push(codeBlock(body.join('\n'), language!));
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]!); i++) {
        quoted.push(inline(QUOTE.exec(lines[i]!)![1]!));
      }
      i--;
      out.push(`<blockquote>${quoted.join('\n')}</blockquote>`);
      continue;
    }
    if (RULE.test(line)) {
      out.push('———');
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push(heading[1] === '' ? '' : `<b>${inline(heading[1]!)}</b>`);
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      out.push(`${bullet[1]}• ${inline(bullet[2]!)}`);
      continue;
    }
    out.push(inline(line));
  }
  return out.join('\n');
}

/**
 * `markdown`, its tables rendered, in parts of at most `limit` code units,
 * as `splitText` cuts them: never inside a table that fits in one part, and
 * with a code block cut in two closed at the end of one part and opened
 * again at the start of the next. Telegram's limit counts the text
 * it shows, which is never longer than the Markdown, so the fences added
 * don't count.
 */
export function splitMarkdown(
  markdown: string,
  limit = TELEGRAM_TEXT_LIMIT,
): string[] {
  const tables = renderTables(markdown);
  const parts: string[] = [];
  let open: { marker: string; line: string } | null = null;
  for (let part of splitText(tables.markdown, limit, tables.blocks)) {
    if (open !== null) {
      const newline = part.indexOf('\n');
      if (
        closesFence(newline === -1 ? part : part.slice(0, newline), open.marker)
      ) {
        // The block's own closing fence: the part before closed it already.
        open = null;
        part = newline === -1 ? '' : part.slice(newline + 1);
        if (part === '') continue;
      }
    }
    const reopened = open?.line;
    for (const line of part.split('\n')) {
      if (open === null) {
        const fence = FENCE.exec(line);
        if (fence) open = { marker: fence[1]!, line: line.trim() };
      } else if (closesFence(line, open.marker)) {
        open = null;
      }
    }
    if (reopened !== undefined) part = `${reopened}\n${part}`;
    if (open !== null) {
      part += `${part.endsWith('\n') ? '' : '\n'}${open.marker}`;
    }
    parts.push(part);
  }
  return parts;
}

/** `text` with the characters HTML reads as markup escaped. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function codeBlock(code: string, language: string): string {
  const body = escapeHtml(code);
  return LANGUAGE.test(language)
    ? `<pre><code class="language-${language}">${body}</code></pre>`
    : `<pre>${body}</pre>`;
}

/** One line's inline Markdown as HTML. */
function inline(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (
      char === '\\' &&
      i + 1 < text.length &&
      /[!-/:-@[-`{-~]/.test(text[i + 1]!)
    ) {
      out += escapeHtml(text[i + 1]!);
      i += 2;
      continue;
    }
    if (char === '`') {
      const run = backticks(text, i);
      const end = text.indexOf(run, i + run.length);
      if (end !== -1 && end > i + run.length && backticks(text, end) === run) {
        const code = text.slice(i + run.length, end);
        out += `<code>${escapeHtml(code.trim() === '' ? code : stripOneSpace(code))}</code>`;
        i = end + run.length;
        continue;
      }
      out += escapeHtml(run);
      i += run.length;
      continue;
    }
    if (char === '[') {
      const link = LINK.exec(text.slice(i));
      if (link) {
        out += `<a href="${escapeHtml(link[2]!)}">${inline(link[1]!)}</a>`;
        i += link[0].length;
        continue;
      }
    }
    const emphasis = emphasisAt(text, i);
    if (emphasis) {
      out += `<${emphasis.tag}>${inline(emphasis.content)}</${emphasis.tag}>`;
      i = emphasis.end;
      continue;
    }
    out += escapeHtml(char);
    i++;
  }
  return out;
}

/** The emphasis that opens at `start` of `text`, if it closes on the line. */
function emphasisAt(
  text: string,
  start: number,
): { tag: string; content: string; end: number } | null {
  for (const { marker, tag, inWord } of EMPHASIS) {
    if (!text.startsWith(marker, start)) continue;
    const from = start + marker.length;
    if (from >= text.length || /\s/.test(text[from]!)) return null;
    if (!inWord && isWordChar(text[start - 1])) return null;
    const close = closingAt(text, from, marker, inWord);
    if (close === -1) return null;
    return {
      tag,
      content: text.slice(from, close),
      end: close + marker.length,
    };
  }
  return null;
}

/**
 * Where `marker` closes in `text` from `from`: after some content not
 * ending in a space, outside code, and, for a single `*` or `_`, not as
 * half of a doubled one. -1 when it doesn't.
 */
function closingAt(
  text: string,
  from: number,
  marker: string,
  inWord: boolean,
): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '`') {
      const run = backticks(text, i);
      const end = text.indexOf(run, i + run.length);
      if (end !== -1) i = end + run.length - 1;
      else i += run.length - 1;
      continue;
    }
    if (!text.startsWith(marker, i)) continue;
    if (marker.length === 1 && text[i + 1] === marker) {
      i++;
      continue;
    }
    // In a longer run, as `***` closing `**bold *italic***`, the last
    // markers close: what comes before them closes inside.
    while (marker.length > 1 && text[i + marker.length] === marker[0]) i++;
    if (i === from || /\s/.test(text[i - 1]!)) continue;
    if (!inWord && isWordChar(text[i + marker.length])) continue;
    return i;
  }
  return -1;
}

function backticks(text: string, at: number): string {
  let end = at;
  while (text[end] === '`') end++;
  return text.slice(at, end);
}

/** Inline code's content without the one space each side may pad it with. */
function stripOneSpace(code: string): string {
  return code.startsWith(' ') && code.endsWith(' ') && code.length > 1
    ? code.slice(1, -1)
    : code;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}
