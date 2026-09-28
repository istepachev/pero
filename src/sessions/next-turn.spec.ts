import { describe, expect, it } from 'vitest';
import { nextTurn } from './next-turn.js';

const agent = { provider: 'claude' as const, workingDirectory: '/vault' };
const session = {
  id: 7,
  provider: 'claude' as const,
  workingDirectory: '/vault',
  providerSessionId: 'abc',
};
const history = { hasHistory: true, carryover: 50 };

describe('nextTurn', () => {
  it('resumes a Session with the same provider and folder, carrying nothing', () => {
    expect(nextTurn(session, agent, history)).toEqual({
      kind: 'resume',
      reason: null,
      from: null,
      sessionId: 7,
      carriesOver: false,
    });
  });

  it('starts fresh after a provider change, carrying the history', () => {
    expect(nextTurn(session, { ...agent, provider: 'codex' }, history)).toEqual(
      {
        kind: 'fresh',
        reason: 'provider',
        from: 'claude',
        sessionId: 7,
        carriesOver: true,
      },
    );
  });

  it('names the provider when both the provider and the folder changed', () => {
    expect(
      nextTurn(
        session,
        { provider: 'codex', workingDirectory: '/own' },
        history,
      ),
    ).toMatchObject({ kind: 'fresh', reason: 'provider', from: 'claude' });
  });

  it('starts fresh after a folder change', () => {
    expect(
      nextTurn(session, { ...agent, workingDirectory: '/own' }, history),
    ).toMatchObject({
      kind: 'fresh',
      reason: 'folder',
      from: '/vault',
      carriesOver: true,
    });
  });

  it('starts a first Session, carrying history a Channel already has', () => {
    expect(nextTurn(null, agent, history)).toEqual({
      kind: 'new',
      reason: null,
      from: null,
      sessionId: null,
      carriesOver: true,
    });
    expect(
      nextTurn(null, agent, { hasHistory: false, carryover: 50 }),
    ).toMatchObject({ kind: 'new', carriesOver: false });
  });

  it('starts over a Session whose first turn never reached the provider', () => {
    expect(
      nextTurn({ ...session, providerSessionId: null }, agent, history),
    ).toMatchObject({ kind: 'restart', sessionId: 7, carriesOver: true });
  });

  it('carries nothing while carry-over is off', () => {
    expect(
      nextTurn(
        session,
        { ...agent, provider: 'codex' },
        { hasHistory: true, carryover: 0 },
      ),
    ).toMatchObject({ kind: 'fresh', carriesOver: false });
  });
});
