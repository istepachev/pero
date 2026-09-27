import { describe, expect, it } from 'vitest';
import { SLUG_MAX_LENGTH, slugSchema, titleSchema } from './slug.js';

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
