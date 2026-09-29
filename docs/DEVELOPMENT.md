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

`npm run cli --` runs the built `pero` CLI. Keep a development installation apart from a real one by using the checkout itself as the workspace, with `-w .` (or `PERO_WORKSPACE`); its `.pero/` and `data/` are Git-ignored:

```sh
npm run build
npm run cli -- run -w .                # start in the background; waits until ready
npm run cli -- status -w .             # process, health, and components
npm run cli -- logs -f -w .            # recent log entries, then new ones
npm run cli -- stop -w .               # graceful stop; waits until it exits
npm run cli -- run --foreground -w .   # attached; logs to stdout
PERO_FAKE_RUNTIME=echo npm run cli -- run -w .   # Agents echo instead of calling a provider
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

## Releasing

A merge to `main` publishes `@perokit/pero` when `package.json` holds a version that is not on npm yet. To release, open a PR that bumps the version and merge it:

```sh
npm version minor --no-git-tag-version   # or patch, major, prerelease; updates package.json and package-lock.json
```

After CI passes on the merge commit, the [Release workflow](../.github/workflows/release.yml) publishes that commit to npm with provenance, then creates the `vX.Y.Z` tag and a GitHub Release with generated notes. A version with a prerelease suffix, such as `0.2.0-beta.1`, is published under the `next` dist-tag and marked as a prerelease. Merges that leave the version alone publish nothing. Don't create release tags by hand. If the workflow fails partway, re-run it: it skips a version npm already has and a release that already exists.

### One-time setup

The workflow publishes through npm [trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token is stored in GitHub. A trusted publisher is configured on the package itself, and the package doesn't exist before its first publish, so the first release uses a short-lived token:

1. **npm organization.** Make sure the `perokit` organization exists on npmjs.com and your account can publish to it (`npm org ls perokit`).
2. **Bootstrap token.** On npmjs.com, open Access Tokens → Generate New Token → Granular Access Token. Give it read and write access to packages in the `@perokit` scope (or to all packages), a 7-day expiry, and enable bypassing two-factor authentication. In the GitHub repository, open Settings → Secrets and variables → Actions and add it as the repository secret `NPM_TOKEN`.
3. **GitHub.** If a tag ruleset covers `v*`, let GitHub Actions create tags. The workflow's `npm` environment is created the first time it runs; you can then restrict its deployment branches to `main` under Settings → Environments.
4. **First release.** Merge the PR that sets the version. Once CI passes, the Release workflow publishes it. Check with `npm view @perokit/pero` and `npm install -g @perokit/pero && pero --version`.
5. **Trusted publisher.** On npmjs.com, open `@perokit/pero` → Settings → Trusted Publisher, choose GitHub Actions, and enter organization `perokit`, repository `pero`, workflow filename `release.yml`, and environment `npm`.
6. **Lock it down.** On the same page, set Publishing access to "Require two-factor authentication and disallow tokens". Revoke the bootstrap token on npm and delete the `NPM_TOKEN` secret from GitHub.

Instead of steps 2 and 4, you can publish the first version yourself with `npm publish` from a clean checkout of `main`; the workflow then finds the version on npm and only creates the GitHub Release.
