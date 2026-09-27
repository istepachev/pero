# pero
Pero — open-source Personal Agent Runtime for running an always-on AI assistant on your VPS — Telegram, scheduled tasks, tools, background workflows, and proactive messaging. It runs on your existing Claude or Codex subscription.

```sh
npm install -g @perokit/pero
pero run
```

Repository: https://github.com/perokit/pero

## Development

Requires Node.js 22.17+ or 24.11+; development uses Node 24 (see `.nvmrc`).

```sh
npm ci
npm run build          # compile to dist/
npm run start:dev      # daemon in watch mode (GET http://127.0.0.1:7717/health)
npm run cli -- --help  # built `pero` CLI
npm test               # unit tests (Vitest)
npm run test:e2e       # e2e tests
npm run lint           # oxlint
```

Design docs live in [docs/](./docs/README.md).
