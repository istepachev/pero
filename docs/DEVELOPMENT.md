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

[Testing](./TESTING.md) describes each test layer, how to run the provider smoke tests as the account the service runs as, how to check a real bot by hand, and which tests verify each behavior.

## Running from a checkout

`npm run cli --` runs the built `pero` CLI. Keep a development installation apart from a real one by using the checkout itself as the workspace, with `-w .` (or `PERO_WORKSPACE`); its `.pero/` and `data/` are Git-ignored:

```sh
npm run build
npm run cli -- run -w .                # start in the background; waits until ready
npm run cli -- status -w .             # process, health, and components
npm run cli -- logs -f -w .            # recent log entries, then new ones
npm run cli -- stop -w .               # graceful stop; waits until it exits
npm run cli -- run --foreground -w .   # attached; logs to stdout
PERO_FAKE_RUNTIME=echo npm run cli -- run -w .   # turns echo instead of calling a provider
```

Every command from the [user guide](./USER_GUIDE.md) works the same way. The environment variables Pero reads at startup are listed under [Configuration](./OPERATIONS.md#configuration).

## Daemon internals

The daemon has no network port. Once ready, it answers on the owner-only control socket `run/pero.sock`, one JSON line per request (`echo '{"op":"status"}' | nc -U -N .pero/run/pero.sock`); the CLI is a client of that socket and never opens the database.

One daemon runs per workspace. It holds a lock on `run/pero.lock` for as long as it runs; a second daemon exits with `Pero is already running for <dir>`. The lock is released by the OS however the daemon ends, so a crashed or killed daemon never blocks the next start. Once ready, the daemon records its pid, version, and socket in `run/pero.json`; that file counts only while the socket answers with the same pid.

The `shutdown` operation, SIGTERM, and SIGINT (Ctrl-C) stop the daemon the same way: it stops intake, waits up to 30 s for active work, closes the database, removes the socket and `run/pero.json`, and exits. `run/pero.lock` stays in place. A second signal exits immediately.

At startup the daemon writes `src/guide/guide.md`, the guide every turn's instructions point to, to `.pero/guide.md` when that file differs. It ships as a build asset (`nest-cli.json`). Keep it in step with [Configuring Pero](./CONFIGURATION.md) when a property or behavior Pero might change or explain changes; `src/guide/agent-guide.spec.ts` fails when its property tables or effort levels drift from the note schemas.

With a bot token set, the daemon long-polls Telegram; readiness never waits for it. [Architecture](./ARCHITECTURE.md) and [CLI and service lifecycle](./CLI.md#process-and-command-boundaries) cover the design in depth.

## Provider smoke tests

The smoke tests run real turns as the current account, using a little of its subscription. Run them as the account the service runs as, as [Testing](./TESTING.md#provider-smoke-tests-under-the-services-account) describes, so that they check the sign-in Pero will use.

```sh
PERO_SMOKE_CLAUDE=1 npm run test:smoke
PERO_SMOKE_CODEX=1 npm run test:smoke   # PERO_SMOKE_CODEX_MODEL changes the resumed turn's model (gpt-5.5 by default)
```

The Claude test creates a session that writes a file, resumes it from another process with a different model and effort, checks that a conversation Claude Code no longer has is reported as lost, checks that an `ask` turn's command is refused and that it writes in its folder but not in the system folder, and aborts a turn. The Codex test does the same with a thread, and also checks that a folder outside Git is refused unless the turn skips the check, checks the `ask` sandbox where it runs, and checks that a signed-out Codex is reported as such.

## Releasing

A merge to `main` publishes `@perokit/pero` when `package.json` holds a version that is not on npm yet. To release, open a PR that bumps the version and merge it:

```sh
npm version minor --no-git-tag-version   # or patch, major, prerelease; updates package.json and package-lock.json
```

Before merging it, walk through [Checking a release on a fresh machine](./TESTING.md#checking-a-release-on-a-fresh-machine) with the PR's branch, and copy its steps into the PR as a checklist.

After CI passes on the merge commit, the [Release workflow](../.github/workflows/release.yml) publishes that commit to npm with provenance, then creates the `vX.Y.Z` tag and a GitHub Release with generated notes. A version with a prerelease suffix, such as `0.2.0-beta.1`, is published under the `next` dist-tag and marked as a prerelease. Merges that leave the version alone publish nothing. Don't create release tags by hand. If the workflow fails partway, re-run it: it skips a version npm already has and a release that already exists.

npm never lets a published version be reused, even after `npm unpublish`. To steer people off a broken version, publish a fixed one, then deprecate the broken one from an account that can publish the package; `npm install` still installs it, with a warning:

```sh
npm deprecate @perokit/pero@<version> "<why>. Install @perokit/pero@latest instead."
```

### Publishing access

The workflow publishes through npm [trusted publishing](https://docs.npmjs.com/trusted-publishers), so no long-lived npm token is needed. On npmjs.com, `@perokit/pero` → Settings → Trusted Publisher names GitHub Actions with organization `perokit`, repository `pero`, workflow filename `release.yml`, and environment `npm`. Publishing by hand, or deprecating a version, needs an account in the `perokit` npm organization (`npm org ls perokit`).

The first release went out with a short-lived bootstrap token in the repository secret `NPM_TOKEN`, which `release.yml` still passes to `npm publish`. With the trusted publisher in place, finish the lockdown: on the same Settings page set Publishing access to "Require two-factor authentication and disallow tokens", revoke the bootstrap token, delete the `NPM_TOKEN` secret, and drop `NODE_AUTH_TOKEN` from the workflow.
