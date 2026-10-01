import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkProviderAuth,
  type Exec,
  type ExecOutcome,
} from './provider-auth.js';

const answer =
  (outcome: ExecOutcome): Exec =>
  () =>
    Promise.resolve(outcome);

const failure = (
  fields: Partial<NodeJS.ErrnoException> & { killed?: boolean },
) => Object.assign(new Error(fields.message ?? 'failed'), fields);

describe('checkProviderAuth', () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('reads a signed-in Claude Code without who is signed in', async () => {
    const stdout = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      email: 'owner@example.com',
      subscriptionType: 'pro',
    });

    await expect(
      checkProviderAuth('claude', { exec: answer({ code: 0, stdout }) }),
    ).resolves.toEqual({
      state: 'ok',
      detail: 'Signed in (claude.ai, pro)',
      installed: true,
    });
  });

  it('reads a signed-out Claude Code', async () => {
    const stdout = JSON.stringify({ loggedIn: false, authMethod: 'none' });

    await expect(
      checkProviderAuth('claude', { exec: answer({ code: 1, stdout }) }),
    ).resolves.toEqual({
      state: 'unconfigured',
      detail: 'Not signed in — run claude auth login',
      installed: true,
    });
  });

  it('reads the Codex sign-in from its exit code', async () => {
    await expect(
      checkProviderAuth('codex', {
        exec: answer({
          code: 0,
          stdout: '',
          stderr: 'WARNING: something\nLogged in using ChatGPT\n',
        }),
      }),
    ).resolves.toEqual({
      state: 'ok',
      detail: 'Logged in using ChatGPT',
      installed: true,
    });
    await expect(
      checkProviderAuth('codex', {
        exec: answer({ code: 1, stdout: 'Not logged in\n' }),
      }),
    ).resolves.toEqual({
      state: 'unconfigured',
      detail:
        'Not signed in — run codex login (on a headless host: codex login --device-auth)',
      installed: true,
    });
  });

  it('explains how to install a missing CLI', async () => {
    const exec = answer({
      code: null,
      stdout: '',
      error: failure({ code: 'ENOENT' }),
    });

    await expect(checkProviderAuth('claude', { exec })).resolves.toEqual({
      state: 'unconfigured',
      detail:
        'Claude Code CLI not found — install it with npm install -g @anthropic-ai/claude-code, then run claude auth login',
      installed: false,
    });
    await expect(checkProviderAuth('codex', { exec })).resolves.toMatchObject({
      detail: expect.stringMatching(/^Codex CLI not found — .*@openai\/codex/),
    });
  });

  it('reports a CLI that does not answer in time as degraded', async () => {
    const exec = answer({
      code: null,
      stdout: '',
      error: failure({ killed: true }),
    });

    await expect(
      checkProviderAuth('claude', { exec, timeoutMs: 2000 }),
    ).resolves.toEqual({
      state: 'degraded',
      detail: 'Could not check sign-in: claude did not answer within 2 s',
      installed: true,
    });
  });

  it('reports output it cannot read as degraded', async () => {
    for (const stdout of ['', 'Welcome!', '{"loggedIn":"yes"}']) {
      await expect(
        checkProviderAuth('claude', { exec: answer({ code: 1, stdout }) }),
      ).resolves.toEqual({
        state: 'degraded',
        detail: 'Could not check sign-in: unexpected output from claude',
        installed: true,
      });
    }
  });

  it('runs the CLI from PATH', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-auth-'));
    const script = join(tmp, 'codex');
    writeFileSync(
      script,
      '#!/bin/sh\necho "WARNING: odd" >&2\necho "Logged in using an API key" >&2\n',
    );
    chmodSync(script, 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${tmp}:${path}`;
    try {
      await expect(checkProviderAuth('codex')).resolves.toEqual({
        state: 'ok',
        detail: 'Logged in using an API key',
        installed: true,
      });
    } finally {
      process.env.PATH = path;
    }
  });
});
