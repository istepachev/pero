/** The longest text one Telegram message may carry, in UTF-16 code units. */
export const TELEGRAM_TEXT_LIMIT = 4096;

/**
 * `text` in parts of at most `limit` code units, each cut after the last
 * blank line, else line break, else space that fits, and never inside a
 * surrogate pair. The separators stay at the end of their part. A cut that
 * would fall inside one of `keep`, a part of `text` that fits in a part of
 * its own, falls before it instead.
 */
export function splitText(
  text: string,
  limit = TELEGRAM_TEXT_LIMIT,
  keep: readonly { start: number; end: number }[] = [],
): string[] {
  const parts: string[] = [];
  let rest = text;
  let offset = 0;
  while (rest.length > limit) {
    let cut = cutAt(rest, limit);
    const inside = keep.find(
      ({ start, end }) =>
        start > offset && start < offset + cut && offset + cut < end,
    );
    if (inside && inside.end - inside.start <= limit) {
      cut = inside.start - offset;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    offset += cut;
  }
  if (rest.length > 0 || parts.length === 0) parts.push(rest);
  return parts;
}

/** Where to end the first part of `text`, which is longer than `limit`. */
function cutAt(text: string, limit: number): number {
  const head = text.slice(0, limit);
  for (const separator of ['\n\n', '\n', ' ']) {
    const at = head.lastIndexOf(separator);
    if (at > 0) return at + separator.length;
  }
  // No separator: cut hard, but keep a surrogate pair together.
  const code = text.charCodeAt(limit - 1);
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}
