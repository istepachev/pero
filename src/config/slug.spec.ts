import { describe, expect, it } from 'vitest';
import { SLUG_MAX_LENGTH, slugify, slugSchema, titleSchema } from './slug.js';

describe('slugSchema', () => {
  it('accepts lowercase words joined by single hyphens', () => {
    for (const value of ['assistant', 'daily-brief', 'q3-review-2026', '7']) {
      expect(slugSchema.parse(value)).toBe(value);
    }
    expect(slugSchema.safeParse('a'.repeat(SLUG_MAX_LENGTH)).success).toBe(
      true,
    );
  });

  it('lowercases input before checking it', () => {
    expect(slugSchema.parse('Daily-Brief')).toBe('daily-brief');
    expect(slugSchema.parse('Q3-REVIEW')).toBe('q3-review');
  });

  it('rejects anything else', () => {
    for (const value of [
      '',
      'Daily Brief',
      'daily brief',
      'daily_brief',
      '-daily',
      'daily-',
      'daily--brief',
      'дневник',
      'ДНЕВНИК',
      'a'.repeat(SLUG_MAX_LENGTH + 1),
    ]) {
      expect(slugSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('titleSchema', () => {
  it('keeps any text as given', () => {
    for (const value of ['Daily brief', '  Spaced  ', '', 'Дневник 📓', null]) {
      expect(titleSchema.parse(value)).toBe(value);
    }
  });
});

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
      const slug = slugify(value);
      expect(slugSchema.parse(slug)).toBe(slug);
    }
  });
});
