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
npm run start:dev      # daemon in watch mode on ./.pero (GET http://127.0.0.1:7717/health)
npm run cli -- --help  # built `pero` CLI
npm test               # unit tests (Vitest)
npm run test:e2e       # e2e tests
npm run lint           # oxlint
```

### Bootstrap configuration

| Setting | Source | Default |
|---|---|---|
| Data directory | `--data-dir`, then `PERO_HOME` | `~/.pero` |
| Log level | `PERO_LOG_LEVEL` (`fatal` … `trace`) | `info` |
| HTTP port (loopback) | `PERO_PORT` | `7717` |

The daemon creates the data directory (`logs/`, `run/`, `secrets/`) owner-only on startup and appends JSON logs to `logs/pero.log`; `--foreground` also writes them to stdout. Invalid values stop startup with a message naming the setting.

Design docs live in [docs/](./docs/README.md).
