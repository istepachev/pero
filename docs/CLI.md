# Pero CLI and service lifecycle

## User experience

The intended installation and daily control surface is one globally installed npm executable:

```sh
npm install -g @your-scope/pero
pero run
pero status
pero agents ls
pero stop
```

Replace `your-scope` with the publisher's npm username or organization scope. The unscoped `pero` package name is already taken, so publish a public scoped package while keeping the terminal command `pero`. npm [scopes](https://docs.npmjs.com/about-scopes/) allow the same package suffix in a separate namespace, and the [`bin` field](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bin) chooses the executable name independently:

```json
{
  "name": "@your-scope/pero",
  "bin": { "pero": "./bin/pero.js" }
}
```

Ship compiled JavaScript and publish the scoped package with `npm publish --access public`. Users need a supported Node.js/npm installation, but do not need to clone the repository, compile TypeScript, install PostgreSQL or Redis, or start a container. A different unscoped name such as `pero-cli` is possible if available, but the scoped name is predictable and remains tied to its publisher.

## Command contract

| Command | Expected behavior |
|---|---|
| `pero run` | Ensure one background Pero process is running for the selected data directory. On first use, create local directories and guide the owner through missing setup. Return only after startup and readiness succeed. Repeated calls report the existing process. |
| `pero run --foreground` | Run the same daemon attached to the terminal for debugging or an external service manager. |
| `pero stop` | Ask the running daemon to stop intake, cancel or finish active work within a bounded period, close the database, and exit. Report when it is already stopped. |
| `pero status` | Show process state, version, data directory, health, and whether Telegram and each configured Agent Runtime are available. |
| `pero logs` | Show recent daemon logs; `--follow` streams new entries. |
| `pero agents ls` | List saved Agents from SQLite, including provider, model choice, working directory, and enabled state. |

The same CLI will expose settings, Agent, Channel, Workflow, and Trigger management commands. Start with list/show/create/edit/disable operations that call application services and validate references. For example, creating an Agent should accept a provider, optional model choice, and optional working directory, with the SQLite installation defaults used when omitted. Changes to provider, model, or folder rotate that Agent's interactive Sessions according to the [architecture](./ARCHITECTURE.md#agent-configuration-and-defaults). Export/import commands can provide reviewable JSON for people who want to edit definitions as files; SQLite remains authoritative after import.

## First run and local files

The default data directory is `~/.pero`, overridable with a CLI option or environment setting. A first interactive `pero run` initializes the SQLite database, applies migrations, seeds installation defaults in SQLite, creates the workspace root, and guides the owner through required Telegram setup and provider sign-in checks. It explains the external Claude Code and Codex CLI sign-in commands when needed. Non-interactive startup fails with a clear missing-setting message rather than waiting for input. A provider can be reported unavailable without silently changing billing mode or switching an Agent to another provider.

```text
~/.pero/
├── pero.sqlite         # settings, definitions, and runtime state
├── workspaces/          # default working folders for new Agents
├── logs/                # background-service logs
├── run/                 # local control endpoint and process metadata
└── secrets/             # owner-only local secrets when needed
```

Provider subscription credentials remain in the provider CLIs' own stores under the same OS account. The Telegram bot token is a separate secret: obtain it during setup or from the service environment and store it in owner-only local secret storage when persistence is needed. Never place provider credentials or Telegram tokens in Agent/Workflow rows or diagnostic output.

## Process and command boundaries

The npm executable is a thin command entry point. `pero run` launches the NestJS daemon as a separate background process with logs redirected to local files, then waits for a readiness response. Node's [detached subprocess documentation](https://nodejs.org/docs/latest-v24.x/api/child_process.html#optionsdetached) describes the required detached/unreferenced process and disconnected standard I/O behavior. The daemon owns Telegram intake, scheduling, execution, and notification delivery. A private local control endpoint serves lifecycle and management requests from the CLI; it must be accessible only to the owner account. When the daemon is stopped, read-only inspection and configuration changes can open SQLite through the same validated application services in a short-lived CLI process.

Permit only one daemon per data directory. Use an exclusive runtime lock and verify a live control endpoint before treating stored process metadata as current; a PID alone can be stale or reused. `pero stop` uses the control endpoint for graceful shutdown instead of killing whatever happens to have a saved PID. Database migrations happen before the daemon reports ready. `pero run` reports startup failures and where to find their logs.

`pero run` keeps the process alive after the invoking terminal exits. Automatic startup after login or reboot is a separate service-manager feature, not implied by this command. The foreground mode provides a stable entry point for launchd, systemd, or another supervisor if the owner chooses one later. Upgrading the global npm package does not replace a running process; restart Pero to use the new version, with migrations run on startup.

## Packaging checks

The package must include the built CLI and daemon files, migrations, and runtime dependencies. Test installation from the packed npm artifact on supported operating systems and architectures, not only from a source checkout. [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3#installation) supplies prebuilt binaries for major platforms, but unsupported combinations may need a local build toolchain; make this a release check. Confirm that global installation creates a working `pero` command, first-run setup works under an ordinary user account, and `run`/`stop`/`status` work after a terminal closes.
