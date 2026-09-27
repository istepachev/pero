import { describe, expect, it } from 'vitest';
import { InvalidInputError, parseInput } from '../common/errors.js';
import {
  settingsChangeSchema,
  telegramBotTokenSchema,
} from './settings-input.js';

const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';

describe('telegramBotTokenSchema', () => {
  it('accepts a token and trims it', () => {
    expect(telegramBotTokenSchema.parse(` ${TOKEN}\n`)).toBe(TOKEN);
  });

  it.each([
    'not-a-token',
    '123456789',
    ':AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs',
    '123456789:short',
    `${TOKEN} extra`,
  ])('refuses %j without repeating it', (value) => {
    let error: unknown;
    try {
      parseInput(settingsChangeSchema, { telegramBotToken: value });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as Error).message).toBe(
      'telegramBotToken: must be a bot token from @BotFather, such as 123456789:AAE…',
    );
  });
});

describe('settingsChangeSchema', () => {
  it('takes settings and the token together, or clears the token', () => {
    expect(
      settingsChangeSchema.parse({
        timezone: 'utc',
        telegramBotToken: TOKEN,
      }),
    ).toEqual({ timezone: 'UTC', telegramBotToken: TOKEN });
    expect(settingsChangeSchema.parse({ telegramBotToken: null })).toEqual({
      telegramBotToken: null,
    });
  });

  it('refuses unknown fields', () => {
    expect(() => parseInput(settingsChangeSchema, { token: TOKEN })).toThrow(
      InvalidInputError,
    );
  });
});
