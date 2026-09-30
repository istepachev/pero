import { describe, expect, it } from 'vitest';
import { SLUG_MAX_LENGTH, slugify } from './slug.js';

describe('slugify', () => {
  it('turns text into a slug', () => {
    expect(slugify('Groceries & Errands')).toBe('groceries-errands');
    expect(slugify('  Q3 -- Review 2026! ')).toBe('q3-review-2026');
    expect(slugify('daily-brief')).toBe('daily-brief');
  });

  it('drops accents', () => {
    expect(slugify('Café Notes')).toBe('cafe-notes');
    expect(slugify('Ærø Øre Straße')).toBe('aero-ore-strasse');
    // Already decomposed input folds the same way.
    expect(slugify('Cafe\u0301')).toBe('cafe');
  });

  it('spells Cyrillic in Latin letters', () => {
    expect(slugify('Дневник')).toBe('dnevnik');
    expect(slugify('Щастя і їжа')).toBe('shchastya-i-yizha');
    expect(slugify('Подъезд, объём')).toBe('podezd-obem');
    expect(slugify('Мой английский 📓')).toBe('moy-angliyskiy');
  });

  it('gives null when no letter or digit is left', () => {
    for (const value of ['', '🎉 !!', '---', '日本語']) {
      expect(slugify(value)).toBeNull();
    }
  });

  it('cuts long text to a slug that still ends in a letter or digit', () => {
    const slug = slugify(`${'a'.repeat(SLUG_MAX_LENGTH - 1)} b c`);
    expect(slug).toBe('a'.repeat(SLUG_MAX_LENGTH - 1));
  });

  it('always yields a valid slug', () => {
    for (const value of [
      'Groceries & Errands',
      'Дневник',
      'x'.repeat(200),
      `${'ab '.repeat(40)}`,
      'Ёлка-2026',
    ]) {
      const slug = slugify(value)!;
      expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    }
  });
});
