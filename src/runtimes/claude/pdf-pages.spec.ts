import { describe, expect, it } from 'vitest';
import { isPdf, pdfPageCount } from './pdf-pages.js';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('isPdf', () => {
  it('finds the header within the first kilobyte', () => {
    expect(isPdf(bytes('%PDF-1.7\n'))).toBe(true);
    expect(isPdf(bytes(`${' '.repeat(100)}%PDF-1.4`))).toBe(true);
    expect(isPdf(bytes(`${' '.repeat(1024)}%PDF-1.4`))).toBe(false);
    expect(isPdf(bytes('milk,1\n'))).toBe(false);
  });
});

describe('pdfPageCount', () => {
  it('reads the page tree', () => {
    expect(
      pdfPageCount(
        bytes(
          '%PDF-1.7\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 12 >>\n' +
            '3 0 obj\n<</Type/Pages/Parent 2 0 R/Count 4>>\n',
        ),
      ),
    ).toBe(12);
  });

  it('errs high when a bookmark tree counts more', () => {
    expect(
      pdfPageCount(
        bytes('<< /Type /Pages /Count 2 >>\n<< /Type /Outlines /Count 30 >>'),
      ),
    ).toBe(30);
  });

  it('is null when the page tree is out of view', () => {
    expect(pdfPageCount(bytes('%PDF-1.7\n<< /Type /ObjStm /N 5 >>'))).toBe(
      null,
    );
    expect(pdfPageCount(bytes('<< /Type /Page /Count 3 >>'))).toBe(null);
    expect(pdfPageCount(bytes('<< /Type /Pages /Kids [] >>'))).toBe(null);
  });
});
