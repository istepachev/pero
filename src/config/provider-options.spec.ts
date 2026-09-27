import { describe, expect, it } from 'vitest';
import { providerDefaultsSchema } from './provider-options.js';

describe('providerDefaultsSchema', () => {
  it('fills a missing provider or option with the provider default', () => {
    expect(
      providerDefaultsSchema.parse({ claude: { model: 'claude-sonnet-5' } }),
    ).toEqual({
      claude: { model: 'claude-sonnet-5', effort: null },
      codex: { model: null, effort: null },
    });
  });

  it('accepts each provider its own effort levels', () => {
    expect(
      providerDefaultsSchema.parse({
        claude: { effort: 'max' },
        codex: { effort: 'minimal' },
      }),
    ).toMatchObject({
      claude: { effort: 'max' },
      codex: { effort: 'minimal' },
    });
  });

  it("rejects another provider's effort level", () => {
    const result = providerDefaultsSchema.safeParse({
      claude: { effort: 'minimal' },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['claude', 'effort']);
  });

  it('rejects unknown providers and options, and an empty model', () => {
    for (const value of [
      { gemini: {} },
      { claude: { temperature: 1 } },
      { codex: { model: ' ' } },
    ]) {
      expect(providerDefaultsSchema.safeParse(value).success).toBe(false);
    }
  });
});
