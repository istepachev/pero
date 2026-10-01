import { describe, expect, it } from 'vitest';
import { checkPropertyNames, editDistance } from './properties.js';

const FILE = 'Agents/Coach.md';
const KNOWN = ['topic', 'provider', 'model', 'effort', 'permissions'];

describe('checkPropertyNames', () => {
  it('keeps known properties', () => {
    expect(
      checkPropertyNames(FILE, { model: 'sonnet', effort: 'high' }, KNOWN),
    ).toEqual({ properties: { model: 'sonnet', effort: 'high' }, errors: [] });
  });

  it("drops Obsidian's own properties without an error", () => {
    expect(
      checkPropertyNames(
        FILE,
        {
          tags: ['pero'],
          aliases: ['Coach'],
          cssclasses: ['wide'],
          model: 'x',
        },
        KNOWN,
      ),
    ).toEqual({ properties: { model: 'x' }, errors: [] });
  });

  it('suggests the closest known property for a typo', () => {
    expect(checkPropertyNames(FILE, { modle: 'sonnet' }, KNOWN)).toEqual({
      properties: {},
      errors: [
        {
          file: FILE,
          property: 'modle',
          message: 'unknown property (did you mean model?)',
        },
      ],
    });
    const suggestion = (property: string) =>
      checkPropertyNames(FILE, { [property]: 1 }, KNOWN).errors[0]!.message;
    expect(suggestion('Model')).toBe('unknown property (did you mean model?)');
    expect(suggestion('topics')).toBe('unknown property (did you mean topic?)');
    expect(suggestion('permission')).toBe(
      'unknown property (did you mean permissions?)',
    );
  });

  it('suggests nothing when no known property is close', () => {
    expect(checkPropertyNames(FILE, { schedule: 'daily' }, KNOWN)).toEqual({
      properties: {},
      errors: [
        { file: FILE, property: 'schedule', message: 'unknown property' },
      ],
    });
    // Two edits turn any two-letter word into another.
    expect(checkPropertyNames(FILE, { ab: 1 }, ['cd']).errors[0]!.message).toBe(
      'unknown property',
    );
  });

  it('reports every unknown property', () => {
    expect(
      checkPropertyNames(FILE, { modle: 1, efort: 2, model: 3 }, KNOWN).errors,
    ).toEqual([
      expect.objectContaining({ property: 'modle' }),
      expect.objectContaining({ property: 'efort' }),
    ]);
  });
});

describe('editDistance', () => {
  it('counts insertions, deletions, substitutions, and swaps', () => {
    expect(editDistance('model', 'model')).toBe(0);
    expect(editDistance('mode', 'model')).toBe(1);
    expect(editDistance('models', 'model')).toBe(1);
    expect(editDistance('modal', 'model')).toBe(1);
    expect(editDistance('modle', 'model')).toBe(1);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });
});
