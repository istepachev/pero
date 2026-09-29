# Developing Pero

How to build, run, and test Pero from a source checkout. The design docs are indexed in [docs/README.md](./README.md).

## Setup

Requires Node.js 22.17+ or 24.11+; development uses Node 24 (see `.nvmrc`).

```sh
git clone https://github.com/perokit/pero.git && cd pero
npm ci
```

## Commands

```sh
npm run build          # compile to dist/
npm run start:dev      # daemon in watch mode on ./.pero
npm run cli -- --help  # built `pero` CLI
npm test               # unit tests (Vitest)
npm run test:e2e       # builds, then runs e2e tests
npm run test:smoke     # builds, then runs real Claude and Codex turns when enabled
npm run lint           # oxlint
npm run typecheck      # tsc --noEmit
npm run format         # prettier
bash scripts/check-packed-install.sh  # install the npm pack artifact globally and drive it
```

[Testing](./TESTING.md) describes each test layer, how to run the provider smoke tests as the account the service runs as, how to check a real bot by hand, and where each phase's exit criteria are verified.

## Running from a checkout

`npm run cli --` runs the built `pero` CLI. Keep a development installation apart from a real one with `--data-dir .pero` (or `PERO_HOME`):

```sh
npm run build
npm run cli -- run --data-dir .pero               # start in the background; waits until ready
npm run cli -- status --data-dir .pero            # process, health, and components
npm run cli -- logs -f --data-dir .pero           # recent log entries, then new ones
npm run cli -- stop --data-dir .pero              # graceful stop; waits until it exits
npm run cli -- run --foreground --data-dir .pero  # attached; logs to stdout
PERO_FAKE_RUNTIME=echo npm run cli -- run --data-dir .pero   # Agents echo instead of calling a provider
```

Every command from the [user guide](./USER_GUIDE.md) works the same way. The environment variables Pero reads at startup are listed under [Configuration](./OPERATIONS.md#configuration).

## Daemon internals

The daemon has no network port. Once ready, it answers on the owner-only control socket `run/pero.sock`, one JSON line per request (`echo '{"op":"status"}' | nc -U -N .pero/run/pero.sock`); the CLI is a client of that socket and never opens the database.

One daemon runs per data directory. It holds a lock on `run/pero.lock` for as long as it runs; a second daemon exits with `Pero is already running for <dir>`. The lock is released by the OS however the daemon ends, so a crashed or killed daemon never blocks the next start. Once ready, the daemon records its pid, version, and socket in `run/pero.json`; that file counts only while the socket answers with the same pid.

The `shutdown` operation, SIGTERM, and SIGINT (Ctrl-C) stop the daemon the same way: it stops intake, waits up to 30 s for active work, closes the database, removes the socket and `run/pero.json`, and exits. `run/pero.lock` stays in place. A second signal exits immediately.

With a bot token set, the daemon long-polls Telegram; readiness never waits for it. [Architecture](./ARCHITECTURE.md) and [CLI and service lifecycle](./CLI.md#process-and-command-boundaries) cover the design in depth.

## Provider smoke tests

The smoke tests run real turns as the current account, using a little of its subscription. Run them as the account the service runs as, as [Testing](./TESTING.md#provider-smoke-tests-under-the-services-account) describes, so that they check the sign-in Pero will use.

```sh
PERO_SMOKE_CLAUDE=1 npm run test:smoke
PERO_SMOKE_CODEX=1 npm run test:smoke   # PERO_SMOKE_CODEX_MODEL changes the resumed turn's model (gpt-5.5 by default)
```

The Claude test creates a session that writes a file, resumes it from another process with a different model and effort, checks that a conversation Claude Code no longer has is reported as lost, checks that an `ask` Agent's command is refused, and aborts a turn. The Codex test does the same with a thread, and also checks that a folder outside Git is refused unless the Agent skips the check, checks the `ask` sandbox where it runs, and checks that a signed-out Codex is reported as such.
