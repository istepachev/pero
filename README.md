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
npm run test:e2e       # builds, then runs e2e tests
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

One daemon runs per data directory. It holds a lock on `run/pero.lock` for as long as it runs; a second daemon exits with `Pero is already running for <dir>`. The lock is released by the OS however the daemon ends, so a crashed or killed daemon never blocks the next start. Once ready, the daemon records its pid, version, and socket in `run/pero.json`; that file counts only while the socket answers with the same pid.

The `shutdown` operation, SIGTERM, and SIGINT (Ctrl-C) stop the daemon the same way: it stops intake, waits up to 30 s for active work, closes the database, removes the socket and `run/pero.json`, and exits. `run/pero.lock` stays in place. A second signal exits immediately.

Design docs live in [docs/](./docs/README.md).
