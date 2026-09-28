import { describe, expect, it } from 'vitest';
import { splitText, TELEGRAM_TEXT_LIMIT } from './split-text.js';

describe('splitText', () => {
  it('keeps text that fits in one part', () => {
    expect(splitText('Hello')).toEqual(['Hello']);
    expect(splitText('')).toEqual(['']);
    const full = 'a'.repeat(TELEGRAM_TEXT_LIMIT);
    expect(splitText(full)).toEqual([full]);
  });

  it('prefers a blank line, then a line break, then a space', () => {
    expect(splitText('one two\nthree\n\nfour', 16)).toEqual([
      'one two\nthree\n\n',
      'four',
    ]);
    expect(splitText('one two\nthree four', 16)).toEqual([
      'one two\n',
      'three four',
    ]);
    expect(splitText('one two three four five', 10)).toEqual([
      'one two ',
      'three ',
      'four five',
    ]);
  });

  it('cuts a long word where it must, never inside a surrogate pair', () => {
    expect(splitText('abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
    // 'a' then an emoji, which takes two code units.
    expect(splitText('a😀b', 2)).toEqual(['a', '😀', 'b']);
  });

  it('loses nothing', () => {
    const text = Array.from(
      { length: 3000 },
      (_, i) => `word${i}${i % 7 === 0 ? '\n' : ' '}`,
    ).join('');
    const parts = splitText(text);
    expect(parts.join('')).toBe(text);
    expect(parts.every((part) => part.length <= TELEGRAM_TEXT_LIMIT)).toBe(
      true,
    );
  });
});
