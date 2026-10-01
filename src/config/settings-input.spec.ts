import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InvalidInputError, parseInput } from '../common/errors.js';
import { telegramBotTokenSchema } from './settings-input.js';

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
      parseInput(z.object({ token: telegramBotTokenSchema }), { token: value });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as Error).message).toBe(
      'token: must be a bot token from @BotFather, such as 123456789:AAE…',
    );
  });
});
