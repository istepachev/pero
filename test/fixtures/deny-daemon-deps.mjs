// Preloaded with `node --import` to prove a CLI command never loads the
// daemon's database stack.
import { registerHooks } from 'node:module';

const DENIED = new Set(['typeorm', '@nestjs/typeorm', 'better-sqlite3']);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (DENIED.has(specifier)) {
      throw new Error(`The CLI must not load ${specifier}`);
    }
    return nextResolve(specifier, context);
  },
});
