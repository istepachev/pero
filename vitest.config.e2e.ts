import { delimiter, join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Fake `claude` and `codex` come first on PATH, so sign-in checks never
// depend on the CLIs installed where the tests run.
const FAKE_BIN = join(import.meta.dirname, 'test/fixtures/bin');

export default defineConfig({
  test: {
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    env: { PATH: `${FAKE_BIN}${delimiter}${process.env.PATH ?? ''}` },
  },
});
