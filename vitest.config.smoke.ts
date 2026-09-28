import { defineConfig } from 'vitest/config';

// Credential-gated smoke tests against real provider SDKs; never in CI.
export default defineConfig({
  test: {
    root: './',
    include: ['test/smoke/**/*.smoke-spec.ts'],
  },
});
