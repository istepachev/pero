/*
 * Markdown tables as Telegram can show them, which is without tables: as a
 * code block, its columns padded to line up in Telegram's monospace font,
 * or, when that is too wide for a phone, as a "Header: value" line per
 * cell, row by row. Pure, so the rules are tested without an adapter.
 */

/** A part of a text that a cut should not fall inside. */
export interface Block {
  start: number;
  end: number;
}

/**
 * The widest a table's lines may be in a code block, in monospace cells:
 * what a phone shows without wrapping them.
 */
export const TABLE_WIDTH = 40;

/** A line opening a code block: its fence, then its language. */
export const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
/** A delimiter row: cells of dashes, each with an optional colon a side. */
const DELIMITER = /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
/** Columns in a code block are separated by this, rows from the header by ─. */
const COLUMN_GAP = ' │ ';

type Align = 'left' | 'right' | 'center';

/**
 * `markdown` with each table, a header row, then a delimiter row such as
 * `|---|:--:|`, then its rows, rendered by `renderTable`, and where each
 * rendered table is in the result. Code blocks and everything that is not
 * a table are left as they are.
 */
export function renderTables(
  markdown: string,
  width = TABLE_WIDTH,
): { markdown: string; blocks: Block[] } {
  const lines = markdown.split('\n');
  const out: string[] = [];
  const blocks: Block[] = [];
  let length = 0;
  const push = (line: string) => {
    out.push(line);
    length += line.length + 1;
  };
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      push(line);
      continue;
    }
    const opened = FENCE.exec(line);
    if (opened) {
      fence = opened[1]!;
      push(line);
      continue;
    }
    const next = lines[i + 1];
    const header = line.includes('|') ? cells(line) : null;
    if (
      header === null ||
      next === undefined ||
      !next.includes('|') ||
      !DELIMITER.test(next) ||
      cells(next).length !== header.length
    ) {
      push(line);
      continue;
    }
    const aligns = cells(next).map(alignOf);
    const rows: string[][] = [];
    for (i += 2; i < lines.length && isRow(lines[i]!); i++) {
      rows.push(cells(lines[i]!));
    }
    i--;
    const start = length;
    for (const rendered of renderTable(header, aligns, rows, width).split(
      '\n',
    )) {
      push(rendered);
    }
    blocks.push({ start, end: length - 1 });
  }
  return { markdown: out.join('\n'), blocks };
}

/**
 * A table as Markdown Telegram shows readably, its cells without their
 * Markdown: a code block with the columns padded to the same display
 * width, or, when a line of it would be wider than `width`, a
 * `**Header:** value` line for each filled cell, with a blank line
 * between rows.
 */
export function renderTable(
  header: readonly string[],
  aligns: readonly Align[],
  rows: readonly (readonly string[])[],
  width = TABLE_WIDTH,
): string {
  const columns = header.length;
  const head = header.map(plain);
  const body = rows.map((row) =>
    Array.from({ length: columns }, (_, column) => plain(row[column] ?? '')),
  );
  const widths = head.map((_, column) =>
    Math.max(1, ...[head, ...body].map((row) => displayWidth(row[column]!))),
  );
  const lineWidth =
    widths.reduce((sum, w) => sum + w, 0) + COLUMN_GAP.length * (columns - 1);
  if (lineWidth > width) return perRow(head, body);

  const line = (row: readonly string[], align: (column: number) => Align) =>
    row
      .map((cell, column) => pad(cell, widths[column]!, align(column)))
      .join(COLUMN_GAP)
      .trimEnd();
  const lines = [
    line(head, () => 'left'),
    widths.map((w) => '─'.repeat(w)).join('─┼─'),
    ...body.map((row) => line(row, (column) => aligns[column] ?? 'left')),
  ];
  const fence = '`'.repeat(Math.max(3, longestRun(lines.join('\n'), '`') + 1));
  return [fence, ...lines, fence].join('\n');
}

/** How many monospace cells `text` takes: two for emoji and East Asian wide characters. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    width += clusterWidth(segment);
  }
  return width;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function clusterWidth(cluster: string): number {
  if (/\p{Emoji_Presentation}|️|\p{Regional_Indicator}/u.test(cluster)) {
    return 2;
  }
  if (isWide(cluster.codePointAt(0)!)) return 2;
  if (/^[\p{Mn}\p{Me}\p{Cf}]+$/u.test(cluster)) return 0;
  return 1;
}

/** East Asian Wide and Fullwidth characters, which take two cells. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** The table one row at a time, a `**Header:** value` line per filled cell. */
function perRow(head: readonly string[], body: readonly string[][]): string {
  if (body.length === 0) return head.map(escapeMarkdown).join(' · ');
  return body
    .map((row) =>
      row
        .map((cell, column) =>
          cell === ''
            ? null
            : `**${escapeMarkdown(head[column] || `Column ${column + 1}`)}:** ${escapeMarkdown(cell)}`,
        )
        .filter((line) => line !== null)
        .join('\n'),
    )
    .filter((block) => block !== '')
    .join('\n\n');
}

function pad(cell: string, width: number, align: Align): string {
  const space = width - displayWidth(cell);
  if (align === 'right') return ' '.repeat(space) + cell;
  if (align === 'center') {
    const left = Math.floor(space / 2);
    return ' '.repeat(left) + cell + ' '.repeat(space - left);
  }
  return cell + ' '.repeat(space);
}

/**
 * A row's cells, trimmed: split at each `|` outside inline code that no
 * backslash escapes, without the pipes at either end.
 */
function cells(line: string): string[] {
  const found: string[] = [];
  let cell = '';
  let code: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '\\' && line[i + 1] === '|') {
      cell += '\\|';
      i++;
    } else if (char === '`') {
      let run = '`';
      while (line[i + 1] === '`') run += line[++i];
      if (code === null) code = run;
      else if (code === run) code = null;
      cell += run;
    } else if (char === '|' && code === null) {
      found.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  found.push(cell);
  const trimmed = found.map((value) => value.trim());
  if (/^\s*\|/.test(line)) trimmed.shift();
  if (/\|\s*$/.test(line) && !/\\\|\s*$/.test(line)) trimmed.pop();
  return trimmed;
}

/** Whether `line` goes on a table: not blank, and with a pipe. */
function isRow(line: string): boolean {
  return line.trim() !== '' && line.includes('|') && !FENCE.test(line);
}

function alignOf(delimiter: string): Align {
  const left = delimiter.startsWith(':');
  const right = delimiter.endsWith(':');
  if (left && right) return 'center';
  return right ? 'right' : 'left';
}

/**
 * A cell's text without its Markdown: emphasis, strikethrough, spoiler,
 * and code marks dropped, a link or image as its text, `<br>` as a space,
 * and backslash escapes resolved.
 */
function plain(cell: string): string {
  return cell
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/(?<!\\)(`+)(.+?)(?<!\\)\1/g, (_, __, code: string) => code.trim())
    .replace(/(\*\*|__|~~|\|\|)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(
      /(?<![\p{L}\p{N}*])\*(?=\S)(.+?)(?<=\S)\*(?![\p{L}\p{N}*])/gu,
      '$1',
    )
    .replace(/(?<![\p{L}\p{N}_])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, '$1')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `text` with the characters Markdown reads as marks escaped. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_~|[\]]/g, '\\$&');
}

function longestRun(text: string, char: string): number {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    run = text[i] === char ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

/** Whether `line` closes a code block that `marker` opened. */
export function closesFence(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length >= marker.length &&
    /^ {0,3}\S/.test(line) &&
    trimmed === marker[0]!.repeat(trimmed.length)
  );
}
