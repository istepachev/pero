/**
 * Whether `data` is a PDF: the header the format puts within its first
 * kilobyte.
 */
export function isPdf(data: Uint8Array): boolean {
  return latin1(data.subarray(0, 1024)).includes('%PDF-');
}

/**
 * How many pages the PDF in `data` has, read from its page tree without a
 * full parser: the largest `/Count` it holds, when a `/Type /Pages`
 * dictionary is in plain view. That may count a bookmark tree or an
 * earlier revision too, so it errs high. Null when the tree is out of
 * view, as in the compressed object streams of many newer PDFs.
 */
export function pdfPageCount(data: Uint8Array): number | null {
  const text = latin1(data);
  if (!/\/Type\s*\/Pages(?![A-Za-z])/.test(text)) return null;
  let count: number | null = null;
  for (const [, digits] of text.matchAll(/\/Count\s+(\d+)/g)) {
    count = Math.max(count ?? 0, Number(digits));
  }
  return count;
}

function latin1(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
    'latin1',
  );
}
