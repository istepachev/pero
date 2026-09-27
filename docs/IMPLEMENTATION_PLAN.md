# Pero implementation plan

This sequence produces a working personal installation in small, reviewable increments. Each phase is split into pull requests that can be merged one at a time; every PR leaves `main` building, linting, type-checking, and passing its tests. The acceptance criteria describe behavior rather than a particular internal class layout.

Each phase ends with **exit criteria**: the phase is complete only when all of them hold, even if every PR in it has merged.

## Phase 1 — boot and persistence

Create the NestJS 12 daemon with validated configuration, Pino logging, SQLite through TypeORM with explicit migrations, and the first entities. Build the `pero` CLI with nest-commander as a client of a private local control endpoint: it never opens the database. Implement `pero run`, `pero run --foreground`, `pero stop`, `pero status`, and `pero logs`, with one background process per data directory, a readiness handshake, and graceful shutdown. The daemon reports ready once the database is migrated, marking missing or invalid Telegram and provider settings as degraded instead of failing. Package compiled CLI and daemon entry points in the public `@perokit/pero` npm package whose `bin` exposes `pero`.

### 1.0 Scaffold ✅

Merged in [perokit/pero#2](https://github.com/perokit/pero/pull/2). NestJS 12 daemon on Fastify bound to loopback with `GET /health`; empty nest-commander `CliModule` that does not import the daemon `AppModule`; `bin/pero.js`; package identity; Vitest, oxlint, Prettier, TypeScript.

### 1.1 CI pipeline

Add a GitHub Actions workflow that runs `npm ci`, build, lint, typecheck, unit tests, and e2e tests on Node 22 and 24, on Linux and macOS.

**Done when:** pull requests show the matrix as required checks and `main` is green.

### 1.2 Bootstrap configuration, data directory, and logging

Resolve bootstrap configuration with Zod: data directory from a `--data-dir` option or `PERO_HOME`, defaulting to `~/.pero`. Add one helper that yields the layout (`pero.sqlite`, `logs/`, `run/`, `secrets/`) and creates missing directories with owner-only permissions. Add Pino logging with redaction, writing structured logs to `logs/` and to stdout in foreground mode. Put shared configuration code where both the CLI and the daemon can import it without pulling in TypeORM.

**Done when:** unit tests cover option/env/default precedence and invalid values with a clear error; the daemon started against a temporary data directory creates the layout and writes JSON log lines to `logs/`.

### 1.3 Persistence foundation and settings

Pin `@nestjs/typeorm`, `typeorm`, and `better-sqlite3`. Add `PersistenceModule`: WAL, foreign keys on, busy timeout, `synchronize: false`, and migrations run during startup before anything else touches the database. Add migration scripts and make the build ship compiled migrations. The first migration creates the singleton `settings` row with default provider, model choice per provider (null = provider default), default working directory (null until setup fills it), shared instructions (null = none), timezone, and operational limits.

**Done when:** an integration test against a real temporary SQLite file shows a fresh database migrates, foreign keys are enforced, the settings row is seeded once, and a second startup is a no-op.

### 1.4 Domain entities

Add the remaining tables from [Architecture §7](./ARCHITECTURE.md#7-persistence-model) in one migration: `agents`, `channels`, `sessions`, `workflows`, `triggers`, `workflow_runs`, `workflow_notification_targets`, `notifications`, and `inbound_updates`, with their unique constraints and indexes. Store Telegram IDs as strings and timestamps in UTC.

**Done when:** migrations apply to an empty database and revert cleanly; tests prove the unique constraints (Agent name, Channel key, run trigger key, inbound update ID) and foreign keys; records survive closing and reopening the database.

### 1.5 Settings and Agent services

Add `SettingsService` (read and validated update of defaults) and an Agent creation/edit service. Creating an Agent copies the default provider and that provider's model choice. Its working directory follows the default unless an explicit absolute folder is given; creation without a folder is rejected while no default is set; add the resolver for the effective folder (own folder, otherwise the default) and for composed instructions (shared instructions unless the Agent opts out, then its own). Editing provider, model, or folder increments `execution_config_version`; changing the default working directory increments it for every Agent that follows the default, in one transaction. No CLI surface yet; these are the services the control endpoint will call.

**Done when:** tests show a new Agent receives the default provider and model, several Agents resolve to the same default folder, an Agent with its own folder keeps it when the default changes while following Agents move and have their version bumped, changing the default provider or model leaves existing Agents unchanged, an invalid or inaccessible folder is rejected, an Agent cannot be created without a folder while the default is unset, and shared instructions are composed unless an Agent opts out.

### 1.6 Control endpoint and component status

Add `ControlModule`: a private endpoint on a Unix domain socket in `run/` with owner-only permissions. Define request/response schemas with Zod in a module shared with the CLI, plus a small typed client for the CLI. First operations: `status` (pid, version, data directory, uptime, component states) and `shutdown`. Add a component-health registry; Telegram and each provider report `unconfigured`/`degraded`/`ok`, and nothing fails startup. The endpoint answers only after migrations complete, which is the readiness signal.

**Done when:** an e2e test boots the daemon on a temporary data directory and receives `status` through the client; the socket is not accessible to other users; a daemon with no Telegram or provider setup reports ready with those components degraded.

### 1.7 Daemon lifecycle: singleton and graceful shutdown

Take an exclusive lock per data directory and write process metadata (pid, version, socket path) to `run/`. Treat metadata as current only if the control endpoint answers; recover from a stale lock after a crash. On `shutdown` or SIGTERM/SIGINT: stop intake, wait a bounded period (from settings), close the database, remove the socket and metadata, and exit.

**Done when:** a second daemon on the same data directory exits with a clear message; a daemon killed with SIGKILL does not block the next start; both a `shutdown` request and SIGTERM leave the database closed and `run/` clean.

### 1.8 CLI: `run`, `stop`, `status`

Add a global `--data-dir` option. `pero run --foreground` runs the daemon attached to the terminal. `pero run` spawns it detached with output redirected to `logs/`, waits for readiness with a timeout, reports an existing process instead of starting a second one, and on failure prints the error and log path. `pero stop` requests shutdown and waits; it reports when Pero is already stopped. `pero status` prints the process and component states. Add the shared guard that makes daemon-required commands exit with `Pero isn't running — start it with pero run`.

**Done when:** e2e tests against a temporary data directory cover `run` → `run` (no duplicate) → `status` → `stop` → `stop` (safe); the daemon survives the parent CLI exiting; a daemon-required command fails clearly when the daemon is stopped.

### 1.9 CLI: `logs`

`pero logs` prints recent daemon log entries from files, readable for humans; `--follow` streams new entries. Works whether or not the daemon is running and never opens the database.

**Done when:** tests cover tailing, following across new writes, and a missing log directory.

### 1.10 First-run setup and degraded configuration

Interactive `pero run` detects missing setup over the control endpoint and guides it: prompt for the Telegram bot token and store it in `secrets/` with owner-only permissions (never in SQLite or logs), ask for the default working directory all Agents share, prefilled with the folder the CLI was started from or `~/workspace` when that is the home directory, and create it if missing, and check `claude auth status` / `codex login status`, explaining the sign-in commands when needed. Non-interactive `pero run` leaves the daemon running degraded and prints actionable missing settings, including an unset default working directory; it does not guess one. Add `pero settings show` and `pero settings set` so defaults (including the default working directory and shared instructions) and the token can be changed later through the daemon.

**Done when:** a daemon with missing Telegram setup starts, reports it as degraded, and becomes configured through `pero settings set` without a restart; non-interactive runs print the missing settings and do not wait for input; secrets never appear in `status`, settings output, or logs.

### 1.11 Backup, restore, and packed install

Add `pero backup <file>`: the daemon writes a consistent snapshot with the SQLite online backup API and archives it with the rest of the data directory. Working folders are the owner's (a vault may already sync elsewhere) and are not included; restore warns when a folder recorded in settings or on an Agent is missing. Add `pero restore <file> --data-dir <dir>`, which runs only with no daemon on the target directory. Add a CI job that installs the `npm pack` artifact into a temporary global prefix, loads `better-sqlite3`, and runs `pero run`, `status`, and `stop` from a fresh home directory.

**Done when:** a backup restores into a fresh data directory and the daemon starts with the same records; the packed-install job passes on the CI matrix.

### Phase 1 exit criteria

Installation from a packed npm artifact exposes `pero`; `pero run` starts a background process and waits for readiness; a second `run` does not create a duplicate; `pero status` reports the process and any degraded components; management commands fail with a clear message when the daemon is stopped; a daemon with missing Telegram setup still starts and can be configured; `pero stop` shuts it down and is safe to repeat. A fresh install initializes its database and defaults; creating an Agent copies the default provider and model into its record and resolves its working folder from the shared default or its own override; changing the default provider or model leaves existing Agents unchanged; a restart keeps records; migrations run cleanly; a backup restores to a fresh data directory.

## Phase 2 — interactive path

Implement the generic Channel router and Channel adapter contract, then add Telegram through grammY as the first integration. Register each Telegram topic as a Channel and assign it an Agent. Implement `AgentManager`, the agent execution runtime contract, and one provider adapter first; add the second through the same contract. Persist provider session IDs and serialize turns per Channel/Session; different Agents may work in the same folder at the same time. Add allowlists and inbound deduplication.

### 2.1 Channel contract and router

Define the normalized inbound message and the adapter contract (`start(onMessage)`, `send(address, message)`). The router resolves `(integration_kind, external_key)` to a Channel, applies the owner/chat allowlist from settings, deduplicates through `inbound_updates`, and rejects unknown addresses with an owner-facing setup hint. Test with an in-memory fake adapter.

**Done when:** tests show unauthorized and duplicate messages never reach the next stage, unknown addresses get the setup hint, and known ones resolve to their Channel and assigned Agent.

### 2.2 Runtime contract, `AgentManager`, and Sessions

Add the `AgentRuntime` contract from [Architecture §5](./ARCHITECTURE.md#5-runtime-contract), `SessionService` (one active Session per Channel/Agent; resume only when `agent_config_version` matches), and `AgentManager`, which builds the request from the Agent record, persists the returned provider session ID before the next turn, and serializes turns per Session. Turns of different Agents run in parallel, even in a shared folder. Wire router → `AgentManager` → adapter reply. Test with a fake runtime.

**Done when:** tests show ordered turns within a Session, parallel turns for different Agents in the same folder, the request carrying the effective folder and composed instructions, a stale config version starting a fresh Session, and provider session IDs persisted across a restart.

### 2.3 Telegram adapter

Add grammY long polling: derive the Channel key from `chat_id` and normalized `message_thread_id`, ignore bot-originated messages, reply in the same topic, and read the token from the secret store. A bad token or network failure marks Telegram degraded rather than stopping the daemon.

**Done when:** tests against a mocked Bot API cover topic routing, bot-loop protection, reply addressing, and degraded status for an invalid token; a manual check with a real bot answers through the fake runtime.

### 2.4 Claude runtime adapter

Implement `ClaudeRuntime` on `@anthropic-ai/claude-agent-sdk`: pass `model` (omit when null) and `cwd` explicitly, create and resume sessions, normalize events, support cancellation, and classify errors. Report the provider as degraded when signed out.

**Done when:** unit tests cover event normalization; a credential-gated smoke test creates a session, resumes it in a new process, and sees a file written in the working directory.

### 2.5 Codex runtime adapter

Implement `CodexRuntime` on `@openai/codex-sdk` through the same contract, mapping `model` and `workingDirectory`, and honoring the Agent's explicit `codex_skip_git_repo_check` setting for non-Git folders.

**Done when:** same coverage as 2.4, plus a test that a non-Git folder is refused unless the Agent opts out.

### 2.6 Agent management commands

Add `pero agents ls|show|create|edit|disable` through the control endpoint, using the 1.5 services. `create` and `edit` accept an explicit folder or a return to following the default, and can opt the Agent out of shared instructions. Editing provider, model, or folder closes the Agent's active Sessions. Validate that folders exist and are accessible before enabling an Agent.

**Done when:** e2e tests cover each command, and an execution-setting edit makes the next turn start a fresh Session.

### 2.7 Channel management commands

Add `pero channels ls|show|enroll|assign|disable`. Enrolling accepts the key from the setup hint; reassigning an Agent closes the old Session.

**Done when:** e2e tests cover enrollment and reassignment, and two Channels assigned to different Agents keep separate Sessions.

### 2.8 End-to-end verification and smoke-test docs

Add an e2e test with two topics routed to different Agents through the fake runtime across a daemon restart. Document how to run the Claude and Codex smoke tests under the service's OS account.

**Done when:** the Phase 2 exit criteria are covered by automated or documented, repeatable tests.

### Phase 2 exit criteria

Two Telegram topics assigned to different Agents retain separate contexts while working in the same shared folder, and an Agent with its own folder works there; a follow-up resumes the right provider session after a process restart; editing provider, model, or folder starts a fresh Session; unauthorized messages do not invoke a runtime. Codex and Claude subscription sign-ins each have a documented SDK smoke test under the OS account running the service.

## Phase 3 — durable workflows

Add manual Triggers, Workflow Runs, and the bounded executor. Add schedule Triggers with timezone-aware `next_run_at` calculation and a polling tick. Create pending runs and advance schedules transactionally. Define missed-run coalescing, retry policy, cancellation, and startup recovery.

### 3.1 Workflow and Trigger definitions

Add Workflow and Trigger services and `pero workflows ls|show|create|edit|disable` and `pero triggers ls|add|remove|disable`, validating Agent references and trigger config with Zod. No execution yet.

**Done when:** e2e tests cover creating, editing, and disabling definitions, and invalid references are rejected.

### 3.2 Manual runs and the bounded executor

`pero workflows run <name>` creates a `pending` Workflow Run with a unique trigger key. A bounded in-process executor claims it, snapshots the Agent's execution settings, and runs it through `AgentManager` in an isolated context, with at most one active run per Workflow. Record `completed` or `failed` with result or error.

**Done when:** tests show the global limit and one-run-per-Workflow rule hold, the snapshot is unaffected by later Agent edits, and a run never touches a Channel's interactive Session.

### 3.3 Schedule calculation

Add schedule Triggers (cron expression and IANA timezone) and a pure function that computes the next occurrence with an explicit daylight-saving policy.

**Done when:** unit tests cover time zones, DST gaps and overlaps, and month/year boundaries.

### 3.4 Scheduler tick

Add a `@nestjs/schedule` polling tick that, in one short transaction per Trigger, creates the pending run and advances `next_run_at`. Missed intervals coalesce to one catch-up run that records the skipped count.

**Done when:** tests show concurrent or repeated polls create one run per occurrence, and a daemon started after downtime creates exactly one catch-up run.

### 3.5 Recovery, retry, and cancellation

On startup, re-queue `pending` runs and mark leftover `running` runs `interrupted`, retrying only when the Workflow's policy allows. Add `pero runs cancel <id>`; graceful shutdown requests cancellation and leaves unresolved runs for recovery.

**Done when:** tests show an interrupted run is visibly recorded and handled according to its policy, and cancellation reaches the runtime.

### Phase 3 exit criteria

A missed scheduled run is found after restart; duplicate polls create one run per trigger occurrence; an interrupted run is visibly recorded and handled according to its policy.

## Phase 4 — notifications and operations

Add Workflow notification targets, durable Notification records, Telegram delivery, retry state, and delivery diagnostics. Expose run inspection, manual retry/cancel, and Workflow/Trigger management through owner-only CLI commands. Document install, credentials, storage, backup, and restore.

### 4.1 Notification targets and records

Add `pero workflows notify <workflow> <channel>` (and removal). When a run finishes, create its Notification records in the same transaction as the final run status.

**Done when:** tests show a completed run and its Notifications commit together, and a Notification failure never keeps a run `running`.

### 4.2 Delivery worker

Dispatch pending Notifications through the Channel adapter with bounded attempts and backoff, recording `provider_message_id`, attempts, and last error. Failed records stay visible.

**Done when:** a simulated Telegram outage leaves the Notification retrying and delivers it once Telegram recovers, without creating another Workflow Run.

### 4.3 Operations commands

Add `pero runs ls|show|retry|cancel` and `pero notifications ls|show|retry` with delivery diagnostics.

**Done when:** e2e tests cover inspection and manual retry of both runs and Notifications.

### 4.4 Operations documentation and restore drill

Document install, provider and Telegram credentials, data layout, backup, and restore. Extend the 1.11 restore test to cover definitions and resumable Sessions, and document backing up the working folders.

**Done when:** a documented backup/restore on a fresh machine brings back definitions and resumable Sessions, with working folders restored from the owner's own backup.

### Phase 4 exit criteria

A Workflow can notify a configured topic; a temporary Telegram delivery failure remains visible and retries without creating duplicate Workflow Runs; restore brings back definitions and resumable sessions.

## Cross-cutting decisions to settle during coding

| Decision | Proposed v1 default |
|---|---|
| Unknown Telegram topic | Reject with an owner-facing setup hint; explicit Channel enrollment. |
| Missed schedule intervals | Coalesce to one catch-up run and record how many intervals were skipped. |
| Workflow concurrency | One active run per Workflow; different Agents and Workflows may share a folder concurrently (last write wins). |
| Interrupted execution | Mark `interrupted`; manual retry by default when side effects may have occurred. |
| Notification retry | Bounded attempts with backoff; retain failed records for inspection. |
| Agent execution settings edit | Close active interactive Sessions when provider, model choice, or effective working directory changes, including a change to the default an Agent follows; start a new provider context on the next turn. |
| Shared instructions | Prepended to each Agent's instructions unless it opts out; edits apply to the next turn without rotating Sessions. Each runtime adapter verifies the SDK accepts updated instructions on a resumed session. |
| Codex in a non-Git folder | Require an explicit Agent setting to skip the SDK Git repository check. |
| Session history | Provider transcript is for provider context; the runtime database stores IDs and operational metadata. |
| Configuration storage | SQLite is authoritative for Agents, Channels, Workflows, and Triggers; CLI operations validate changes. JSON export/import may be added without live file synchronization. |
| Background lifecycle | `pero run` survives terminal exit; automatic startup after reboot is a separate service-manager feature. |

## Highest-value verification

Test the boundaries that could lose or misroute work: CLI start/readiness/stop, singleton process behavior, Telegram topic identity, Session resume after restart, atomic schedule claim/deduplication, interruption handling, and Notification retries. Use a real temporary SQLite database for persistence tests. Test global installation from a packed npm artifact on supported operating systems, including `better-sqlite3` loading. Provider SDK smoke tests can be gated on credentials; mocks alone cannot prove resume and filesystem behavior.
