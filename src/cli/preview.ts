/** How much of a long text `preview` shows. */
const PREVIEW_LENGTH = 60;

/** The first line of `text`, shortened, and how many lines it has. */
export function preview(text: string | null): string {
  if (text === null) return '(none)';
  const lines = text.split('\n');
  const first = lines[0]!.trim();
  const shown =
    first.length > PREVIEW_LENGTH
      ? `${first.slice(0, PREVIEW_LENGTH - 1)}…`
      : first;
  return lines.length > 1 ? `${shown} (${lines.length} lines)` : shown;
}
