import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComponentHealth } from './component-health.js';

describe('ComponentHealth', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with Telegram and each provider unconfigured', () => {
    const health = new ComponentHealth();

    expect(health.list()).toEqual([
      expect.objectContaining({ name: 'claude', state: 'unconfigured' }),
      expect.objectContaining({ name: 'codex', state: 'unconfigured' }),
      expect.objectContaining({
        name: 'telegram',
        state: 'unconfigured',
        detail: 'Bot token is not set',
      }),
    ]);
    expect(health.overall()).toBe('degraded');
  });

  it('is ok only once every component is', () => {
    const health = new ComponentHealth();

    health.report('telegram', 'ok');
    health.report('claude', 'ok');
    expect(health.overall()).toBe('degraded');

    health.report('codex', 'ok');
    expect(health.overall()).toBe('ok');

    health.report('claude', 'degraded', 'Signed out');
    expect(health.overall()).toBe('degraded');
  });

  it('ignores a component that is not required', () => {
    const health = new ComponentHealth();
    health.report('telegram', 'ok');
    health.report('claude', 'ok');

    health.setRequired('codex', false);
    expect(health.overall()).toBe('ok');

    health.report('codex', 'degraded', 'Timed out');
    expect(health.list().find((c) => c.name === 'codex')?.required).toBe(false);
    expect(health.overall()).toBe('ok');

    health.setRequired('codex', true);
    expect(health.overall()).toBe('degraded');
  });

  it('moves since only when the state changes', () => {
    vi.useFakeTimers({ now: new Date('2026-09-28T10:00:00Z') });
    const health = new ComponentHealth();
    const telegram = () => health.list().find((c) => c.name === 'telegram');

    vi.setSystemTime(new Date('2026-09-28T11:00:00Z'));
    health.report('telegram', 'degraded', 'Network is down');
    expect(telegram()).toEqual({
      name: 'telegram',
      state: 'degraded',
      detail: 'Network is down',
      since: '2026-09-28T11:00:00.000Z',
      required: true,
    });

    vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
    health.report('telegram', 'degraded', 'Timed out');
    expect(telegram()).toMatchObject({
      detail: 'Timed out',
      since: '2026-09-28T11:00:00.000Z',
    });
  });

  it('adds a component on its first report', () => {
    const health = new ComponentHealth();

    health.report('scheduler', 'ok');

    expect(health.list().map((c) => c.name)).toContain('scheduler');
  });
});
