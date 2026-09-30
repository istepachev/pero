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
  it('takes the token, or clears it', () => {
    expect(settingsChangeSchema.parse({ telegramBotToken: TOKEN })).toEqual({
      telegramBotToken: TOKEN,
    });
    expect(settingsChangeSchema.parse({ telegramBotToken: null })).toEqual({
      telegramBotToken: null,
    });
  });

  it('refuses any other setting, which notes and config.yaml hold', () => {
    for (const change of [{ token: TOKEN }, { timezone: 'UTC' }]) {
      expect(() => parseInput(settingsChangeSchema, change)).toThrow(
        InvalidInputError,
      );
    }
  });
});
