# Pero CLI and service lifecycle

## User experience

The intended installation and daily control surface is one globally installed npm executable:

```sh
npm install -g @perokit/pero
pero run
pero status
pero agents ls
pero stop
```

The package is `@perokit/pero`, published under the `perokit` npm organization from [github.com/perokit/pero](https://github.com/perokit/pero). The unscoped `pero` package name is already taken, so Pero ships as a public scoped package while keeping the terminal command `pero`. npm [scopes](https://docs.npmjs.com/about-scopes/) allow the same package suffix in a separate namespace, and the [`bin` field](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bin) chooses the executable name independently:

```json
{
  "name": "@perokit/pero",
  "repository": { "type": "git", "url": "git+https://github.com/perokit/pero.git" },
  "bin": { "pero": "./bin/pero.js" }
}
```

Ship compiled JavaScript and publish `@perokit/pero` with `npm publish --access public`. Users need a supported Node.js/npm installation, but do not need to clone the repository, compile TypeScript, install PostgreSQL or Redis, or start a container.

## Command contract

| Command | Expected behavior |
|---|---|
| `pero run` | Ensure one background Pero process is running for the selected data directory. On first use, create local directories and guide the owner through missing setup. Return only after startup and readiness succeed. Repeated calls report the existing process. |
| `pero run --foreground` | Run the same daemon attached to the terminal for debugging or an external service manager. |
| `pero stop` | Ask the running daemon to stop intake, cancel or finish active work within a bounded period, close the database, and exit. Report when it is already stopped. |
| `pero status` | Show process state, version, data directory, health, and whether Telegram and each configured Agent Runtime are available. Exit with status 3 when Pero is stopped. |
| `pero logs` | Show the most recent entries of `logs/pero.log` (`-n <count>`, default 50) as readable lines in local time; `--follow` streams new entries and `--json` prints the raw JSON lines. Reads files only, so it works whether or not the daemon is running; it points to `logs/daemon.out` rather than streaming it. |
| `pero settings show` | Show the installation settings by the names `set` takes; the Telegram bot token only as set or not set, and where it comes from. `pero settings` alone does the same. |
| `pero settings set <key> [value]` | Change one setting through the daemon: `default-provider`, `claude.model`, `claude.effort`, `codex.model`, `codex.effort`, `default-working-directory` (relative to the current folder, `~` allowed), `shared-instructions`, `timezone`, `max-concurrent-runs`, or `telegram-bot-token`. Without a value it prompts on a terminal or reads stdin, so long instructions can come from a file. The token is refused as an argument, so it never lands in shell history. |
| `pero settings unset <key>` | Clear a setting: provider options return to the provider default, shared instructions to none, and the stored bot token is deleted. The default working directory can be changed but not cleared. |
| `pero backup <file>` | Ask the running daemon to write a backup: a consistent snapshot of the database from the SQLite online backup API, archived with `secrets/` and a manifest as an owner-only gzip tar. Logs, `run/`, and working folders are not included. The file must be outside the data directory; an existing file is replaced. |
| `pero restore <file>` | Restore a backup into the selected data directory, which must be missing or empty; it never overwrites an installation. Runs without the daemon and refuses while one answers for that directory. Warns about each working folder recorded in settings or on an Agent that does not exist here. |
| `pero agents ls` | List saved Agents, including provider, model, effort, working directory (and whether it follows the default), and enabled state. |

Every command except `run`, `run --foreground`, `stop`, `status`, `logs`, and `restore` requires the running daemon. When it is stopped, the command exits with `Pero isn't running — start it with pero run` and does not start it implicitly.

The same CLI will expose settings, Agent, Channel, Workflow, and Trigger management commands. Start with list/show/create/edit/disable operations; each sends a request to the daemon, whose application services validate references and apply the change. For example, creating an Agent should accept a provider, optional provider options (model, effort), and optional working directory, with the SQLite installation defaults used when omitted; an Agent without its own folder follows the default working directory. A change of provider or effective folder makes that Agent's next turn in each Channel start a fresh Session; model, effort, and instructions apply from the next turn of the same Session (see the [Session policy](./ARCHITECTURE.md#5-runtime-contract)). Export/import commands can provide reviewable JSON for people who want to edit definitions as files; SQLite remains authoritative after import.

## First run and local files

The default data directory is `~/.pero`, overridable with the `--data-dir` option or the `PERO_HOME` environment variable (the option wins). On a first `pero run`, the daemon initializes the SQLite database, applies migrations, seeds installation defaults, and reports ready without Telegram or provider setup. An interactive `pero run` then guides the owner through choosing the working folder all Agents share (prefilled with the current folder, or `~/workspace` when run from the home directory), Telegram setup, and provider sign-in checks over the control endpoint, explaining the external Claude Code and Codex CLI sign-in commands when needed. A non-interactive run leaves the daemon running in a degraded state and prints the missing settings, each with the command that fixes it, rather than waiting for input; it does not guess a working folder. Every answer goes to the daemon at once, so an interrupted setup keeps what was done, and a later `pero run` asks only for what is still missing and checks sign-in again. A provider can be reported unavailable without silently changing billing mode or switching an Agent to another provider.

Only providers in use count toward health: the default provider and any provider an enabled Agent uses. The other one is still listed in `pero status`, marked `(not in use)`, and setup does not ask to sign in to it. The daemon runs `claude auth status` and `codex login status` as its own account when it starts and whenever `pero run` asks.

The Telegram bot token is stored in `secrets/telegram-bot-token` (owner-only, replaced atomically), never in SQLite, logs, `pero status`, or `pero settings show`. A token in the daemon's environment as `PERO_TELEGRAM_BOT_TOKEN` wins over the stored one, which suits a service manager; `pero run` passes its own environment to the daemon it starts. Changing the token takes effect without a restart.

```text
~/.pero/
├── pero.sqlite         # settings, definitions, and runtime state
├── logs/
│   ├── pero.log         # daemon logs, JSON lines
│   └── daemon.out       # raw stdout/stderr of a daemon started by `pero run`
├── run/                 # local control endpoint and process metadata
└── secrets/             # owner-only local secrets when needed
```

Provider subscription credentials remain in the provider CLIs' own stores under the same OS account. The Telegram bot token is a separate secret: obtain it during setup or from the service environment and store it in owner-only local secret storage when persistence is needed. Never place provider credentials or Telegram tokens in Agent/Workflow rows or diagnostic output.

## Process and command boundaries

The npm executable is a thin command entry point: `bin/pero.js` loads the compiled [nest-commander](https://nest-commander.jhunt.dev/) CLI, which runs `CommandFactory.run(CliModule)`. `CliModule` imports only what commands need, not the full daemon `AppModule`, so commands start quickly without booting Telegram, the scheduler, or provider SDKs. `pero run` launches the NestJS daemon as a separate background process with logs redirected to local files, then waits for a readiness response. Node's [detached subprocess documentation](https://nodejs.org/docs/latest-v24.x/api/child_process.html#optionsdetached) describes the required detached/unreferenced process and disconnected standard I/O behavior. The daemon owns Telegram intake, scheduling, execution, notification delivery, and exclusive access to SQLite. A private local control endpoint serves lifecycle and management requests from the CLI; it must be accessible only to the owner account. The CLI never opens the database or loads TypeORM: it is a client of the control endpoint, sharing request schemas with the daemon. This keeps a single writer, lets the daemon update its in-memory state (schedules, Sessions, Channel routing) directly when definitions change, and ensures only the daemon runs migrations.

Once the database is open and migrated, the daemon must start and report ready even when settings are missing or invalid. A bad Telegram token, a signed-out provider CLI, or an invalid Agent folder marks that component degraded in `pero status` instead of failing startup, so the owner can always fix configuration with ordinary commands. Only file-level maintenance that requires a stopped daemon, such as restoring a backup, runs without it.

Permit only one daemon per data directory. Use an exclusive runtime lock and verify a live control endpoint before treating stored process metadata as current; a PID alone can be stale or reused. `pero stop` uses the control endpoint for graceful shutdown instead of killing whatever happens to have a saved PID. Database migrations happen before the daemon reports ready. `pero run` reports startup failures, printing the daemon's own output from `logs/daemon.out` and where to find the logs.

`pero run` keeps the process alive after the invoking terminal exits. Automatic startup after login or reboot is a separate service-manager feature, not implied by this command. The foreground mode provides a stable entry point for launchd, systemd, or another supervisor if the owner chooses one later. Upgrading the global npm package does not replace a running process; restart Pero to use the new version, with migrations run on startup.

## Packaging checks

The package must include the built CLI and daemon files, migrations, and runtime dependencies. Test installation from the packed npm artifact on supported operating systems and architectures, not only from a source checkout. [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3#installation) supplies prebuilt binaries for major platforms, but unsupported combinations may need a local build toolchain; make this a release check. Confirm that global installation creates a working `pero` command, first-run setup works under an ordinary user account, and `run`/`stop`/`status` work after a terminal closes. CI runs `scripts/check-packed-install.sh` on every supported OS and Node version: it installs the `npm pack` artifact into a temporary global prefix, loads `better-sqlite3` from it, and runs `run`, `status`, `backup`, `stop`, and `restore` from a fresh home directory.
