# Pero tech stack and deployment

## 1. Stack decision

| Layer | Initial choice | Why it fits |
|---|---|---|
| Language and runtime | TypeScript on [Node.js](https://nodejs.org/en/about/previous-releases) `^22.17.0 \|\| >=24.11.0` (22.17 is the first 22.x that loads the CommonJS nest-commander alongside ESM NestJS without a `require()` cycle error); develop on 24 LTS | Shared types and a stable long-running server runtime. Support the Node lines in active or maintenance LTS and test each one in CI; drop a line when it reaches end of life (Node 22: April 2027). |
| Application framework | [NestJS 12](https://docs.nestjs.com/) modular monolith | Dependency injection, modules, lifecycle hooks, and one composition root for bot, scheduler, API, and workers. |
| CLI framework | [nest-commander](https://nest-commander.jhunt.dev/) | `pero` commands are Nest providers built on `commander`, so they can inject the same validated application services as the daemon. The Nest CLI (`@nestjs/cli`) is a development tool only. |
| CLI control | Unix domain socket in the data directory's `run/`, one JSON line per request and reply | Owner-only through filesystem permissions, with no port or token; each data directory has its own endpoint, so several daemons can share a machine. |
| HTTP adapter | None until webhooks need it; then Fastify via `@nestjs/platform-fastify` | The daemon is a Nest application context with no network listener. |
| First Channel integration | Telegram via grammY | Bot update handling and reply delivery; each Telegram topic is a Channel. Slack and Discord can be added later as separate Channel adapters. |
| Agent execution | `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` | Provider implementations behind an internal `AgentRuntime` contract. |
| Persistence | TypeORM + `better-sqlite3` + SQLite WAL | One local database file for configuration, sessions, schedules, run state, and notifications. |
| Scheduling | `@nestjs/schedule` plus a database-backed due-trigger poller | The package clocks the tick; SQLite holds the authoritative schedule. |
| Active work | Bounded in-process executor (`p-queue` or a small custom executor) | Controls concurrency without a Redis service; pending runs remain in SQLite. |
| Validation | Zod | Parse configuration, webhook payloads, and flexible JSON fields at boundaries. |
| Logging | Pino | Structured logs with correlation IDs and redaction. |
| Tests | Vitest | Unit tests for time calculations and integration tests for recovery and routing. |
| Package management and distribution | Public `@perokit/pero` npm package with a `pero` executable | One package and `package-lock.json` for development; users install `@perokit/pero` globally and invoke `pero`. |
| Deployment | `pero run` launches a native background service on the owner's machine or VPS | The CLI handles lifecycle and management; Claude Code and Codex use sign-in under the same OS account. |

The earlier proposal of PostgreSQL, Drizzle, Redis/BullMQ, and separate gateway/worker processes was superseded by the self-hosted v1 decision. PostgreSQL and Redis remain possible future options, not mandatory dependencies.

## 2. Repository layout

```text
pero/
├── bin/
│   └── pero.js
├── src/
│   ├── cli/             # nest-commander CliModule and commands; main.ts is the `pero` entry
│   ├── daemon/          # daemon main.ts and AppModule bootstrap
│   ├── control/
│   ├── agents/
│   ├── runtimes/
│   │   ├── claude/
│   │   └── codex/
│   ├── channels/
│   │   └── telegram/
│   ├── sessions/
│   ├── workflows/
│   ├── triggers/
│   ├── scheduler/
│   ├── notifications/
│   ├── tools/
│   ├── persistence/
│   │   ├── entities/
│   │   └── migrations/
│   └── app.module.ts    # full daemon module graph
├── test/
├── package.json
├── package-lock.json
└── README.md
```

A workspace/monorepo is unnecessary for the first deployable version. If gateway and worker become separate processes, this layout can be extracted into packages then.

Commit `package-lock.json`. Use `npm install` when changing dependencies and `npm ci` for clean development and CI installs; [`npm ci` verifies the lockfile matches `package.json` without rewriting either file](https://docs.npmjs.com/cli/v11/commands/npm-ci/). Ship compiled JavaScript and migrations in the published package. The unscoped npm name `pero` is taken, so Pero is published under the `perokit` organization [scope](https://docs.npmjs.com/about-scopes/) as `@perokit/pero`, using [`npm publish --access public`](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/). npm's [`bin` field](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bin) still exposes the global `pero` command. Test installation from `npm pack` output rather than assuming a source checkout behaves like the published package.

## 3. Database configuration

`PersistenceModule` (`src/persistence/`) configures TypeORM:

```ts
TypeOrmModule.forRootAsync({
  useFactory: () => ({
    type: 'better-sqlite3',
    database: layout.database,
    enableWAL: true,
    timeout: 5000,
    entities: ENTITIES, // explicit lists, no file globs
    migrations: MIGRATIONS,
    synchronize: false,
    toRetry: () => false, // fail startup at once instead of retrying
  }),
  // initialize(), then runMigrations(): the DataSource provider resolves
  // only once the schema is current.
  dataSourceFactory: openDatabase,
});
```

TypeORM documents the `better-sqlite3` driver, `enableWAL`, and `timeout` options in its [SQLite driver guide](https://typeorm.io/docs/drivers/sqlite/); the driver turns foreign keys on for every connection. Migrations run during controlled startup, before Telegram intake and scheduler ticks begin, and an integration test verifies WAL, foreign keys, and the busy timeout. Use short write transactions for schedule advancement, run creation, and delivery state changes; agent executions must run outside database transactions.

**Migrations** live in `src/persistence/migrations/`. Every migration is added by hand to the `MIGRATIONS` list in that folder's `index.ts`, so the compiled package ships them without globbing. Create a migration with `npm run migration:create -- src/persistence/migrations/<Name>`, or diff the entities against the development database with `migration:generate`. `migration:show`, `migration:run`, and `migration:revert` also exist. Each script except `migration:create` builds first and targets `PERO_HOME`, which defaults to the development data directory `.pero`. A test fails if the entities and the migrations describe different schemas.

WAL allows readers while a writer is active, but SQLite still has one writer at a time. Store the database on a local persistent filesystem, not a network share. A live backup must use SQLite's backup API or another consistent snapshot method; copying only `pero.sqlite` while WAL is active may omit recent committed work. See [SQLite WAL](https://www.sqlite.org/wal.html) and the [SQLite online backup API](https://www.sqlite.org/backup.html).

## 4. Runtime integration

`ClaudeRuntime` and `CodexRuntime` each own provider configuration, session/thread creation and resume, stream translation, cancellation, and error classification. Pero stores provider IDs as opaque values. It should never use a provider's native transcript as its only record of application state.

The [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) runs the Claude Code agent loop in a process the operator controls and supports sessions and tools. The [Codex SDK](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) wraps the Codex CLI and supports persisted threads and streamed events. Package versions and exact adapter calls should be pinned and validated against the installed SDKs during implementation.

The Agent record supplies `provider` and its provider options (`model`, `effort`), and `AgentManager` resolves its effective `workingDirectory` (see [Architecture §2](./ARCHITECTURE.md#agent-configuration-and-defaults)), for both interactive turns and Workflow Runs. The Claude adapter maps these to the SDK's `model`, `effort`, and `cwd` query options; the [Claude configuration guide](https://code.claude.com/docs/en/agent-sdk/configuration) documents both. The Codex adapter maps them to `model`, `modelReasoningEffort`, and `workingDirectory` thread options, documented in the [Codex SDK options source](https://github.com/openai/codex/blob/main/sdk/typescript/src/threadOptions.ts). A null option means omit it, so the provider uses its default. Always pass the working directory explicitly instead of inheriting Pero's process directory.

[Codex SDK documentation](https://github.com/openai/codex/blob/main/sdk/typescript/README.md#working-directory-controls) says its working directory normally must be a Git repository. For a Codex Agent, validate this at setup. A shared notes folder such as an Obsidian vault is often not a Git repository, so a Codex Agent working there needs this setting. If the owner deliberately chooses a non-Git folder, expose an explicit setting that maps to `skipGitRepoCheck`; do not silently bypass the check. Changing a Claude Agent's working directory requires a new session according to Anthropic's configuration guide; Pero applies the same new-session rule when the provider or any provider option changes, for predictable behavior across adapters.

Keep the database, working folders, and provider session state on persistent local storage owned by the account running the service. The shared working directory and any Agent's own folder live outside the data directory, such as a notes vault or a project; document their backup and permissions separately. Test session resume after a process restart. Keep credentials out of Agent definitions and database rows.

## 5. Channel integrations and HTTP

`ChannelsModule` exposes normalized inbound message and outbound delivery contracts. Telegram is the first implementation: its adapter resolves a topic to a Channel using the `chat_id` and `message_thread_id` provided by the [Bot API](https://core.telegram.org/bots/api), then replies with those same routing values. The initial transport may use long polling for a simple install; a webhook mode can be added if a public HTTPS endpoint is available. Only configured chats and users may invoke agents. Deduplicate inbound updates and guard against bot-generated message loops. Later Slack and Discord adapters provide their own address mapping, authorization checks, and delivery logic while reusing Agent, Session, Workflow, and Notification services.

The CLI reaches the daemon through `run/pero.sock`, a Unix domain socket. `run/` is owner-only and so is the socket, so the kernel refuses other accounts at `connect()`; no token is needed, and browsers cannot reach it. Each connection carries one request: the client writes one JSON line (`{"op":"status"}`), and the daemon answers with one JSON line (`{"ok":true,"result":…}` or `{"ok":false,"error":{"code","message"}}`) and closes it. Request and result schemas are Zod definitions shared by the CLI and the daemon. The socket opens only after migrations, so an answer means the daemon is ready.

The daemon has no HTTP listener. When a Channel needs webhooks, add NestJS's [Fastify adapter](https://docs.nestjs.com/techniques/performance) for signed webhooks only, and keep administration on the socket. HTTP availability must not be required for scheduled workflows if no external endpoint is configured.

## 6. Scheduler and executor

`@nestjs/schedule` runs one periodic poller; [Nest's scheduling guide](https://docs.nestjs.com/application/task-scheduling) describes the package. User schedules live in `triggers`, including cron expression, timezone, and `next_run_at`. The poller creates pending Workflow Runs in a transaction and advances `next_run_at`. The executor reads pending runs, applies the global concurrency limit and one active run per Workflow, and updates run status. After restart it recovers pending and interrupted runs according to policy.

The in-process executor is deliberately disposable: its contents can be rebuilt from SQLite. It must not be the sole store of work. A Redis queue is an optional later change once there are multiple processes or hosts.

## 7. Native installation and subscription authentication

After installing a supported Node.js/npm version, the intended application install is `npm install -g @perokit/pero`; then `pero run` initializes the local data directory on first use and starts the background service. See [CLI and service lifecycle](./CLI.md) for the command contract. Claude Code and Codex CLI sign-in must be available on the same machine and under the same OS account as Pero's long-lived process. Start with the owner's account for the simplest setup; a dedicated account is possible if the owner signs both CLIs in under that account. The runtime does not implement its own Claude or ChatGPT login screen and does not accept provider credentials through Agent definitions. First-run setup checks sign-ins and runs a short SDK execution for each configured provider before accepting work from that provider.

| Agent execution | Owner setup | Verification |
|---|---|---|
| Codex SDK | Sign in to the Codex CLI with ChatGPT. On a headless host, use its device-code flow if enabled for the account. | `codex login status`, then an SDK run as the service account. |
| Claude Agent SDK | Sign in to Claude Code with the owner's Claude subscription. | `claude auth status`, then an Agent SDK run as the service account. |

[Official OpenAI documentation](https://learn.chatgpt.com/docs/auth) describes ChatGPT subscription sign-in, headless device-code login, and local credential storage under `CODEX_HOME`. The [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) controls a local Codex agent. Keep its credential store writable for token refresh and private to the service account.

[Anthropic's June 2026 update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says the planned change to Agent SDK subscription usage was paused and that Agent SDK and third-party app usage continue to draw from subscription limits for now. The [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) documents subscription sign-in and `claude auth status`. Anthropic's [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) also contains separate approval wording about third-party products offering claude.ai login. Because these statements address different aspects of the integration, verify the policy for this distributed self-hosted runtime before release; the v1 implementation uses the owner's CLI sign-in and provides no embedded provider login flow.

Keep every Agent's working directory and resumable session state on persistent local storage. Protect the OS account's Claude and Codex credential stores as secrets. If either subscription sign-in is absent or expires, mark that Agent Runtime unavailable and show a clear reauthentication action; do not switch billing modes silently.

**Backup:** make a consistent SQLite snapshot, then back up that snapshot together with the working folders that need recovery, runtime session state, and configuration needed to restore. `pero backup` covers the data directory (database snapshot and `secrets/`); working folders and the provider CLIs' own session and credential stores need the owner's own backup. Either protect credential stores in a separate encrypted backup or sign in again after restore. Test restoration to a fresh data directory with `pero restore`. Do not copy a live WAL database file alone. Logs can be sent to stdout or a system log service.

## 8. Configuration and observability

Keep provider subscription credentials in the CLIs' protected credential stores. The CLI defaults to `~/.pero` for its data directory, with an explicit override available before opening SQLite. First-run setup creates the database and seeds a `settings` row. Settings, Agent/Channel definitions, Workflows, and Triggers are authoritative in SQLite and changed through validated CLI commands. These settings include default provider, default options (model and effort) for each provider, default working directory, shared instructions, allowed users/chats, timezone, and concurrency limits. A null option means the provider's own default; a string pins a provider-specific model name or effort level. JSON export/import may be supported for review and bulk edits, but is not a second live configuration store.

First-run setup obtains the Telegram token or reads it from the service environment, storing it in owner-only local secret storage if persistence is needed. Provider credentials and Telegram tokens do not belong in the settings row. Validate CLI input and any environment-supplied bootstrap values with Zod; fail early with a clear error.

When the owner creates an Agent, Pero copies the selected provider and that provider's default options from SQLite settings; changing those defaults affects future Agents only, so a default change never silently switches an existing Agent's provider, model, or effort. The working directory is different: every Agent uses the shared default working directory, filled during setup, unless the owner explicitly gives it its own absolute folder. Changing the default rotates the Sessions of the Agents that follow it. If an Agent's execution settings change, close its active Sessions and use the new settings for subsequent runs. Capture the execution settings when a Workflow Run starts so later Agent edits do not alter that run midway.

Log structured fields such as `correlationId`, `channelId`, `agentId`, `workflowRunId`, `runtimeKind`, duration, and outcome. Redact tokens, prompts that may contain private data, and tool outputs by default. Expose basic counters for run states, queue depth, failure rates, and notification retries; add OpenTelemetry/Sentry later if operating experience calls for them.

## 9. Version and compatibility checks

The stack is a design decision, not a floating dependency specification. Before starting implementation, pin mutually compatible releases of NestJS 12 (`@nestjs/core`, `@nestjs/schedule`, `@nestjs/typeorm`, and later `@nestjs/platform-fastify` on their 12.x lines), TypeORM, `better-sqlite3`, grammY, both agent SDKs, and Node; commit the lockfile. Exercise a smoke test for each provider that creates a session, resumes it after process restart, and verifies workspace persistence. Recheck SDK authentication, permission, and session storage behavior when upgrading.
