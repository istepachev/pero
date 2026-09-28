import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntimes } from './agent-runtimes.js';
import { ClaudeRuntime } from './claude/claude-runtime.js';
import { CodexRuntime } from './codex/codex-runtime.js';
import { RuntimeOptionsModule, RuntimesModule } from './runtimes.module.js';
import { FakeAgentRuntime } from './testing/fake-agent-runtime.js';

describe('RuntimesModule', () => {
  it('runs Claude Agents on Claude Code and Codex Agents on Codex', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RuntimesModule],
    }).compile();

    const runtimes = moduleRef.get(AgentRuntimes);
    expect(runtimes.get('claude')).toBeInstanceOf(ClaudeRuntime);
    expect(runtimes.get('codex')).toBeInstanceOf(CodexRuntime);
  });

  it('answers with an echo for every provider when asked to, with a warning', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const moduleRef = await Test.createTestingModule({
      imports: [RuntimeOptionsModule.forRoot({ fake: 'echo' }), RuntimesModule],
    }).compile();

    const runtimes = moduleRef.get(AgentRuntimes);
    expect(runtimes.get('claude')).toBeInstanceOf(FakeAgentRuntime);
    expect(runtimes.get('codex')).toBeInstanceOf(FakeAgentRuntime);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('PERO_FAKE_RUNTIME=echo'),
    );
    warn.mockRestore();
  });
});
