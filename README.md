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
npm run start:dev      # daemon in watch mode on ./.pero
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

The daemon creates the data directory (`logs/`, `run/`, `secrets/`) owner-only on startup and appends JSON logs to `logs/pero.log`; `--foreground` also writes them to stdout. Invalid values stop startup with a message naming the setting.

The daemon has no network port. Once ready, it answers on the owner-only control socket `run/pero.sock`, one JSON line per request:

```sh
echo '{"op":"status"}' | nc -U -N .pero/run/pero.sock
```

Design docs live in [docs/](./docs/README.md).
