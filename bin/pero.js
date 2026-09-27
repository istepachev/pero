#!/usr/bin/env node
process.setSourceMapsEnabled(true);

await import('../dist/cli/main.js');
