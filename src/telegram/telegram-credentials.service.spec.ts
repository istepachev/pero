import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComponentHealth } from '../health/component-health.js';
import { TelegramCredentials } from './telegram-credentials.service.js';

const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';
const OTHER = '987654321:BBEhBOweik6ad9r_QXMENQjcrGbqCr4K-xy';

describe('TelegramCredentials', () => {
  let tmp: string;
  let envFile: string;
  let gitignore: string;
  let health: ComponentHealth;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-telegram-'));
    envFile = join(tmp, '.env');
    gitignore = join(tmp, '.gitignore');
    health = new ComponentHealth();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function create(env: NodeJS.ProcessEnv = {}) {
    const credentials = new TelegramCredentials(
      { envFile, gitignore, env },
      health,
    );
    credentials.onModuleInit();
    return credentials;
  }

  const telegram = () => health.list().find((c) => c.name === 'telegram');
  const stored = () =>
    existsSync(envFile) ? readFileSync(envFile, 'utf8') : null;

  it('is unconfigured without a token', () => {
    const credentials = create();

    expect(credentials.token()).toBeNull();
    expect(credentials.source()).toBeNull();
    expect(telegram()).toMatchObject({
      state: 'unconfigured',
      detail: 'Bot token is not set',
    });
  });

  it('stores the token in .env, owner-only, and lists .env in .gitignore', () => {
    writeFileSync(envFile, '# Secrets\nOTHER=1\n', { mode: 0o600 });
    writeFileSync(gitignore, 'node_modules/\n');
    const credentials = create();

    credentials.set(TOKEN);
    credentials.set(OTHER);

    expect(credentials.token()).toBe(OTHER);
    expect(credentials.source()).toBe('env-file');
    // The adapter reports the connection from here on.
    expect(telegram()).toMatchObject({
      state: 'degraded',
      detail: 'Connecting to Telegram',
    });
    expect(stored()).toBe(
      `# Secrets\nOTHER=1\nPERO_TELEGRAM_BOT_TOKEN=${OTHER}\n`,
    );
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(gitignore, 'utf8')).toBe('node_modules/\n.env\n');

    credentials.set(null);
    expect(stored()).toBe('# Secrets\nOTHER=1\n');
    expect(credentials.token()).toBeNull();
    expect(telegram()).toMatchObject({ state: 'unconfigured' });
  });

  it('reads .env on start', () => {
    writeFileSync(envFile, `PERO_TELEGRAM_BOT_TOKEN="${TOKEN}"\n`, {
      mode: 0o600,
    });
    expect(create().token()).toBe(TOKEN);
  });

  it('prefers the environment over .env', () => {
    create().set(OTHER);

    const credentials = create({ PERO_TELEGRAM_BOT_TOKEN: TOKEN });

    expect(credentials.token()).toBe(TOKEN);
    expect(credentials.source()).toBe('environment');
    expect(telegram()?.detail).toBe('Connecting to Telegram');

    // Stored, but the environment still wins.
    credentials.set(OTHER);
    expect(credentials.token()).toBe(TOKEN);
    expect(stored()).toBe(`PERO_TELEGRAM_BOT_TOKEN=${OTHER}\n`);
  });

  it('reports an invalid token in the environment as degraded', () => {
    const credentials = create({ PERO_TELEGRAM_BOT_TOKEN: 'nope' });

    expect(credentials.token()).toBeNull();
    expect(credentials.source()).toBe('environment');
    expect(telegram()).toMatchObject({
      state: 'degraded',
      detail: 'PERO_TELEGRAM_BOT_TOKEN is not a valid bot token',
    });
  });

  it('reports a damaged stored token as degraded', () => {
    writeFileSync(envFile, 'PERO_TELEGRAM_BOT_TOKEN=garbage\n', {
      mode: 0o600,
    });

    const credentials = create();

    expect(credentials.token()).toBeNull();
    expect(telegram()?.state).toBe('degraded');
  });

  it('tells listeners about each change', () => {
    const credentials = create();
    const seen: (string | null)[] = [];
    const stop = credentials.onChange((token) => seen.push(token));

    credentials.set(TOKEN);
    credentials.set(null);
    stop();
    credentials.set(OTHER);

    expect(seen).toEqual([TOKEN, null]);
  });

  it('refuses an invalid token without storing it', () => {
    const credentials = create();

    expect(() => credentials.set('nope')).toThrow();
    expect(stored()).toBeNull();
  });

  it('refuses a .env others can read, until it is owner-only again', () => {
    writeFileSync(envFile, `PERO_TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
    chmodSync(envFile, 0o644);

    const credentials = create();

    expect(credentials.token()).toBeNull();
    expect(credentials.source()).toBe('env-file');
    expect(telegram()).toMatchObject({
      state: 'degraded',
      detail: `${envFile} is readable by other users; run chmod 600 ${envFile}`,
    });

    // Storing it again writes the file owner-only.
    credentials.set(TOKEN);
    expect(credentials.token()).toBe(TOKEN);
  });
});
