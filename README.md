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
| Data directory | `--data-dir` (any `pero` command, before or after its name), then `PERO_HOME` | `~/.pero` |
| Log level | `PERO_LOG_LEVEL` (`fatal` … `trace`) | `info` |
| Telegram bot token | `PERO_TELEGRAM_BOT_TOKEN` in the daemon's environment, then `secrets/telegram-bot-token` | none |

The daemon creates the data directory (`logs/`, `run/`, `secrets/`) owner-only on startup and appends JSON logs to `logs/pero.log`; `--foreground` also writes them to stdout. Invalid values stop startup with a message naming the setting.

### Running the daemon

```sh
npm run cli -- run --data-dir .pero     # start in the background; waits until ready
npm run cli -- status --data-dir .pero  # process, health, and components
npm run cli -- stop --data-dir .pero    # graceful stop; waits until it exits
npm run cli -- logs -f --data-dir .pero # recent log entries, then new ones
npm run cli -- run --foreground --data-dir .pero  # attached; logs to stdout
```

`pero run` starts the daemon detached in its own session, so it keeps running after the terminal closes, and reports the running daemon instead of starting a second one. The daemon's own stdout and stderr (startup errors, crashes) go to `logs/daemon.out`; on a failed start, `pero run` prints that output and both log paths. `pero stop` and a repeated `pero run` are safe when there is nothing to do. `pero status` exits 3 when Pero is stopped. Commands that need the daemon fail with `Pero isn't running — start it with pero run` rather than starting it.

`pero logs` prints the last 50 entries of `logs/pero.log` as readable lines in local time (`-n <count>` for more or fewer); `--follow` keeps streaming new entries, waiting for the file if Pero has not written it yet, and `--json` prints the raw lines for `jq`. It reads files only, so it works whether or not the daemon is running. It does not stream `logs/daemon.out`, but it names that file on stderr when it has content.

### First-run setup and settings

The daemon starts even when nothing is configured, reporting what is missing as degraded. `pero run` then checks what is still needed: the default working directory all Agents share, the Telegram bot token, and sign-in for the providers in use (the default provider, plus any provider an Agent uses). On a terminal it asks for each one: the folder is prefilled with the current folder (`~/workspace` when started from home) and created if missing, the token is typed hidden, and it waits while you run `claude auth login` or `codex login` elsewhere. Without a terminal it prints the missing settings with the commands that fix them and returns at once.

```sh
npm run cli -- settings --data-dir .pero                       # show everything
npm run cli -- settings set default-working-directory ~/notes --data-dir .pero
printf '%s' "$TOKEN" | npm run cli -- settings set telegram-bot-token --data-dir .pero
npm run cli -- settings set shared-instructions --data-dir .pero < persona.md
npm run cli -- settings unset claude.model --data-dir .pero    # back to the provider default
```

Keys: `default-provider`, `claude.model`, `claude.effort`, `codex.model`, `codex.effort`, `default-working-directory`, `shared-instructions`, `timezone`, `max-concurrent-runs`, `telegram-bot-token`. A value left out is read from a prompt on a terminal, otherwise from stdin; the token is never accepted as an argument. It is stored owner-only in `secrets/telegram-bot-token` and never shown or logged. Changes apply without a restart.

The daemon has no network port. Once ready, it answers on the owner-only control socket `run/pero.sock`, one JSON line per request (`echo '{"op":"status"}' | nc -U -N .pero/run/pero.sock`); the CLI is a client of that socket and never opens the database.

One daemon runs per data directory. It holds a lock on `run/pero.lock` for as long as it runs; a second daemon exits with `Pero is already running for <dir>`. The lock is released by the OS however the daemon ends, so a crashed or killed daemon never blocks the next start. Once ready, the daemon records its pid, version, and socket in `run/pero.json`; that file counts only while the socket answers with the same pid.

The `shutdown` operation, SIGTERM, and SIGINT (Ctrl-C) stop the daemon the same way: it stops intake, waits up to 30 s for active work, closes the database, removes the socket and `run/pero.json`, and exits. `run/pero.lock` stays in place. A second signal exits immediately.

Design docs live in [docs/](./docs/README.md).
