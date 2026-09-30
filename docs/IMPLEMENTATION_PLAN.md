# Pero implementation plan

This sequence produces a working personal installation in small, reviewable increments. Each phase is split into pull requests that can be merged one at a time; every PR leaves `main` building, linting, type-checking, and passing its tests. The acceptance criteria describe behavior rather than a particular internal class layout.

Each phase ends with **exit criteria**: the phase is complete only when all of them hold, even if every PR in it has merged.

Phases 1–4 built Pero 0.1, where Agents, Workflows, and settings lived in SQLite and changed through the CLI. Phases 5–10 moved that configuration into files for 0.2: a workspace with `.env`, `config.yaml`, and Markdown notes, with SQLite keeping only state. Where the two differ, the later phases describe what Pero does now, and the [configuration reference](./CONFIGURATION.md) describes the files.

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

Pin `@nestjs/typeorm`, `typeorm`, and `better-sqlite3`. Add `PersistenceModule`: WAL, foreign keys on, busy timeout, `synchronize: false`, and migrations run during startup before anything else touches the database. Add migration scripts and make the build ship compiled migrations. The first migration creates the singleton `settings` row with default provider, `provider_defaults` (JSON with each provider's model and effort, validated by a Zod schema per provider; null = provider default), default working directory (null until setup fills it), shared instructions (null = none), timezone, and operational limits.

**Done when:** an integration test against a real temporary SQLite file shows a fresh database migrates, foreign keys are enforced, the settings row is seeded once, and a second startup is a no-op.

### 1.4 Domain entities

Add the remaining tables from [Architecture §7](./ARCHITECTURE.md#7-persistence-model) in one migration: `agents`, `channels`, `sessions`, `workflows`, `triggers`, `workflow_runs`, `workflow_notification_targets`, `notifications`, and `inbound_updates`, with their unique constraints and indexes. Store Telegram IDs as strings and timestamps in UTC.

**Done when:** migrations apply to an empty database and revert cleanly; tests prove the unique constraints (Agent name, Channel key, run trigger key, inbound update ID) and foreign keys; records survive closing and reopening the database.

### 1.5 Settings and Agent services

Add `SettingsService` (read and validated update of defaults) and an Agent creation/edit service. Creating an Agent copies the default provider and that provider's options. Its working directory follows the default unless an explicit absolute folder is given; creation without a folder is rejected while no default is set; add the resolver for the effective folder (own folder, otherwise the default) and for composed instructions (shared instructions unless the Agent opts out, then its own). Changing the default working directory moves every Agent that follows it, because the folder is resolved when it is used. No CLI surface yet; these are the services the control endpoint will call.

**Done when:** tests show a new Agent receives the default provider and its options, several Agents resolve to the same default folder, an Agent with its own folder keeps it when the default changes while following Agents move, changing the default provider or provider options leaves existing Agents unchanged, an invalid or inaccessible folder is rejected, an Agent cannot be created without a folder while the default is unset, and shared instructions are composed unless an Agent opts out.

### 1.6 Control endpoint and component status

Add `ControlModule`: a private endpoint on a Unix domain socket in `run/` with owner-only permissions. Define request/response schemas with Zod in a module shared with the CLI, plus a small typed client for the CLI. First operations: `status` (pid, version, data directory, uptime, component states) and `shutdown`. Add a component-health registry; Telegram and each provider report `unconfigured`/`degraded`/`ok`, and nothing fails startup. The endpoint answers only after migrations complete, which is the readiness signal. The loopback HTTP listener from 1.0 is removed, so daemons for different data directories can run side by side.

**Done when:** an e2e test boots the daemon on a temporary data directory and receives `status` through the client; the socket is not accessible to other users; a daemon with no Telegram or provider setup reports ready with those components degraded.

### 1.7 Daemon lifecycle: singleton and graceful shutdown

Take an exclusive lock per data directory and write process metadata (pid, version, socket path) to `run/`. Treat metadata as current only if the control endpoint answers; recover from a stale lock after a crash. On `shutdown` or SIGTERM/SIGINT: stop intake, wait a fixed bounded period, close the database, remove the socket and metadata, and exit.

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

Implement the generic Channel router and Channel adapter contract, then add Telegram through grammY as the first integration. The recommended Telegram setup is one private forum group: the owner creates a bot, creates a group, enables topics, adds the bot as an administrator, and allows the group's chat ID. Each topic in that group is a Channel, and creating a topic onboards a new Agent for it. The group's General topic and a direct chat with the bot are Channels too; neither has a topic ID. Implement `AgentManager`, the agent execution runtime contract, and one provider adapter first; add the second through the same contract. Persist provider session IDs and serialize turns per Channel/Session; different Agents may work in the same folder at the same time. Add the chat allowlist, pairing, and inbound deduplication. Record the text each Channel sends and receives as its message history, so a fresh Session, such as one on another provider, can continue from the recent conversation.

Telegram addressing, used throughout this phase:

| Where the message is | Channel key | Reply goes to | Channel created as |
|---|---|---|---|
| A topic of an allowed forum group | `<chat_id>:<message_thread_id>` | same chat and `message_thread_id` | a new Agent named after the topic |
| The General topic of an allowed forum group | `<chat_id>` | same chat, no `message_thread_id` | the main Agent |
| An allowed group without topics | `<chat_id>` | same chat, no `message_thread_id` | the main Agent |
| A direct chat with the bot (allowed user ID) | `<chat_id>` (equals the user ID) | same chat | the main Agent |

A `message_thread_id` counts only when `is_topic_message` is true; in a group without topics it identifies a reply thread and is ignored, so replies there never split a Channel. The main Agent is the one named by the `main-agent` setting; when unset, the first General topic or direct chat creates an Agent named `main` and records it there.

### 2.1 Channel contract, router, and allowlist

Define the normalized inbound message and the adapter contract: `start(handlers)` with a message handler and a channel-event handler (topic created or renamed, chat ID migrated, bot membership changed), and `send(address, message)`. A normalized message carries the integration kind, the chat (key, kind `private`/`group`, title), the Channel key and title, the external message and sender IDs, and content. Add a migration for `allowed_chats` (integration kind, chat key, kind, title, timestamps; unique per integration and chat key), a `title` column on `channels`, and a nullable `main_agent_id` in settings. The router checks the chat against `allowed_chats`, deduplicates through `inbound_updates`, and resolves `(integration_kind, external_key)` to a Channel. A chat that is not allowed never reaches the next stage; it gets a pairing hint naming its chat ID and the command that allows it (`pero telegram allow <chat-id>`) when the bot is added to it or receives a message there, at most once per chat per hour. An unknown Channel in an allowed chat goes to onboarding (2.2) instead of being rejected. Test with an in-memory fake adapter.

**Done when:** tests show messages from chats not in the allowlist and duplicate updates never reach the next stage, the pairing hint is rate-limited, known Channel keys resolve to their Channel and assigned Agent, and unknown keys in an allowed chat are handed to onboarding.

### 2.2 Channel onboarding

A new Channel in an allowed chat creates its Agent through the 1.5 services and then its Channel, in one transaction. A topic gets a new Agent: its name is the topic title as a slug (accents dropped, Cyrillic spelled in Latin letters), with `-2`, `-3`, … when that name is taken, or `topic-<message_thread_id>` when the title has no letters or digits to keep; its title is the topic title. The name comes from an `AgentNamer`, so a later one can ask a model. The Agent receives the default provider and options, follows the default working directory, and has no instructions of its own. A General topic or direct chat is assigned the main Agent, creating `main` when the setting is unset. Onboarding runs on the topic-created event, and on the first message in an unknown topic (a topic created before the bot joined, or while Pero was down past Telegram's update retention), taking the title from the topic-creation message the Bot API attaches when present. It then posts a welcome in the new Channel: the Agent's name, provider, model, and folder, and the command to change it. A message that triggered onboarding then goes on to the Agent. When no default working directory is set, onboarding creates nothing, replies with the `pero settings set default-working-directory` hint, and runs again on the next message there. A renamed topic updates the Channel title and the Agent title, never the Agent name. Onboarding never changes an existing Channel's assignment.

**Done when:** tests show a created topic yields exactly one Agent and one Channel even when the topic-created event and its first message both arrive, name collisions and titles without letters or digits get unique slugs, a General topic and a direct chat share the main Agent through separate Channels, a missing default folder leaves nothing behind and succeeds on retry once it is set, and a rename changes titles only.

### 2.3 Runtime contract, `AgentManager`, and Sessions

Add the `AgentRuntime` contract from [Architecture §5](./ARCHITECTURE.md#5-runtime-contract), `SessionService` (one active Session per Channel/Agent; resume only while the Agent's provider and effective working directory match the ones the Session recorded, otherwise close it and start fresh), and `AgentManager`, which builds the request from the Agent record, persists the returned provider session ID before the next turn, and serializes turns per Session. Turns of different Agents run in parallel, even in a shared folder. Wire router → `AgentManager` → adapter reply. Test with a fake runtime.

**Done when:** tests show ordered turns within a Session, parallel turns for different Agents in the same folder, the request carrying the effective folder and composed instructions, a changed provider or effective folder starting a fresh Session while a changed model or effort resumes the same one, provider session IDs persisted across a restart, and a General topic and a direct chat assigned to the same Agent keeping separate Sessions.

### 2.4 Message history and carry-over

Add a `messages` table that records every message exchanged in a Channel. Each row holds:
- the Channel, plus the Agent and Session it belongs to (null for Pero's own notices);
- the direction: `in` or `out`;
- the origin: `user`; `agent`; `pero` for Pero's own notices, such as the onboarding welcome and failure messages; or `workflow`, added in 4.2;
- the external message and sender IDs, the text, and the time.

Index it by Channel and time, and by time alone for windows across Channels.

When messages are recorded:
- A user message is recorded when the router hands it to its Channel's Agent, in the same transaction that marks its claimed update processed, so a redelivered update is never recorded twice. The Channel may not exist until onboarding runs after the claim, so the claim itself is too early. The message gets its Session when its turn starts.
- An Agent's reply is recorded once it has been sent. It is one row even when the adapter splits it into several messages.
- The history holds only the text exchanged in the chat. It has no reasoning, tool activity, intermediate events, or provider transcripts.
- Nothing is recorded for chats that are not allowed, pairing hints, or messages to a disabled Channel.

Carry-over:
- **When it applies:** a turn runs in a Session with no provider session ID yet, in a Channel that already has history, because the Agent's provider or effective folder changed or the Channel was reassigned. A Session whose first turn failed before the provider reported an ID gets it again, since that provider has none of the conversation either. Pero's own notices are not carried over.
- **What it adds:** `AgentManager` places the Channel's most recent messages before that first turn's input, as a transcript marked as earlier conversation, so the new provider session picks up where the old one stopped.
- **Limits:** the `history-carryover` setting caps the number of messages (default 50; 0 turns carry-over off). A fixed character budget then drops the oldest first.
- **Resumed Sessions:** a resumed Session gets nothing extra, since its provider already has the context.

**Done when:** tests show:
- inbound and outbound messages are recorded once each, with their Channel, Agent, and Session;
- nothing is recorded for a chat that is not allowed or a disabled Channel;
- the first turn after a provider change carries the latest messages within the cap and budget, while a resumed turn carries none;
- `history-carryover 0` turns carry-over off.

### 2.5 Telegram adapter

Add grammY long polling for `message` and `my_chat_member` updates, reading the token from the secret store. Normalize addresses as in the table above; map `forum_topic_created` and `forum_topic_edited` service messages to channel events, and `migrate_to_chat_id` to a chat-migrated event that moves the allowlist entry and Channel keys to the supergroup's new ID (enabling topics on a basic group changes its chat ID). Ignore messages from bots, which also stops loops. Reply in the same topic; in the General topic, a group without topics, or a direct chat, send without `message_thread_id`. On startup and on each membership change, check with `getChatMember` whether the bot is an administrator of each allowed group: without that (or privacy mode turned off in BotFather) Telegram delivers only commands, mentions, and replies to the bot, so the chat is reported degraded with the fix. A bad token or network failure marks Telegram degraded rather than stopping the daemon.

**Done when:** tests against a mocked Bot API cover the four address kinds in both directions, reply-thread IDs ignored in a group without topics, topic created/renamed events, chat migration, bot-loop protection, the not-an-administrator warning, and degraded status for an invalid token; a manual check with a real bot in a forum group and a direct chat answers through the fake runtime and onboards a new topic.

### 2.6 Telegram chats and pairing

Add `pero telegram chats` (allowed chats with kind, title, the bot's administrator status and whether topics are on, followed by chats that recently asked to pair), `pero telegram allow <chat-id>`, and `pero telegram deny <chat-id>`, which removes the chat from the allowlist and keeps its Channels and Agents for when it is allowed again. Allowing happens only on the host, never from a Telegram message. `pero status` shows the bot's username and flags Telegram degraded while no chat is allowed or an allowed group lacks administrator rights. Extend first-run setup (1.10): once the token is valid and no chat is allowed, an interactive `pero run` prints the recommended steps (create a group, enable topics, add the bot as an administrator, or message the bot directly), waits for the first update from a new chat, and asks whether to allow it. Non-interactive runs list `pero telegram allow` among the missing settings.

**Done when:** e2e tests cover allow, deny, and listing through a fake adapter; interactive setup allows a chat that sent its first message during setup; a denied chat's messages reach no runtime, and allowing it again resumes its Channels and Sessions.

### 2.7 Claude runtime adapter

Implement `ClaudeRuntime` on `@anthropic-ai/claude-agent-sdk`: pass `model` and `effort` (each omitted when null) and `cwd` explicitly, create and resume sessions, normalize events, support cancellation, and classify errors. Report the provider as degraded when signed out. Give each Agent a permission mode in its tool policy, copied from a `default-permissions` setting: `bypass` runs every tool without asking; `ask` lets the Agent read and edit in its folder and sends other tools to an approver on the runtime request, refusing them while none is attached. Optionally, name onboarded Agents with a one-shot model call behind `AgentNamer`, falling back to the slug of the title when the model fails or answers with anything but a slug.

**Done when:** unit tests cover event normalization; a credential-gated smoke test creates a session, resumes it in a new process with a different model and effort, and sees a file written in the working directory.

### 2.7b Tool approvals in Telegram

Answer the runtime request's approver from the Channel: post what the Agent wants to run with Allow and Deny buttons, which anyone in the allowed chat may press, and edit the message to show who answered. Extend the Channel contract with buttons, editing a sent message, and a handler for button presses, and have the Telegram adapter poll `callback_query`. A request not answered within 10 minutes, or whose turn is aborted or outlived by Pero, is denied, and a later press is told it expired. Workflow Runs have no approver, and neither do Codex Agents, whose `ask` mode is their sandbox (2.8).

**Done when:** tests with the fake adapter and a mocked Bot API cover allow, deny, timeout, abort, a stale press, and a press from a chat that is not allowed, and a turn continues after an allow.

### 2.8 Codex runtime adapter

Implement `CodexRuntime` on `@openai/codex-sdk` through the same contract, mapping `model`, `effort` (as `modelReasoningEffort`), and `workingDirectory`, and honoring the Agent's explicit `codex_skip_git_repo_check` setting for non-Git folders. Pass the Agent's instructions as Codex developer instructions. `codex exec` cannot ask the owner mid-turn, so map the permission modes to Codex's sandbox: `ask` writes and runs commands only in the Agent's folder without network access, and `bypass` runs unsandboxed.

**Done when:** same coverage as 2.7, including resuming a thread with a different model and effort, plus a test that a non-Git folder is refused unless the Agent opts out.

### 2.9 Agent management commands

Add `pero agents ls|show|create|edit|disable|enable` through the control endpoint, using the 1.5 services, and the `main-agent` setting to `pero settings`. `create` and `edit` accept an explicit folder or a return to following the default, and can opt the Agent out of shared instructions. `show` lists the Channels assigned to the Agent and says when a Channel's next turn will start a fresh Session because the provider or effective folder changed. Validate that folders exist and are accessible before enabling an Agent.

**Done when:** e2e tests cover each command; after a provider or folder edit the next turn starts a fresh Session that carries over the Channel's recent messages, and after a model or effort edit it resumes the same one; an Agent created by onboarding can be edited like any other.

### 2.10 Channel management commands

Add `pero channels ls|show|assign|disable|enable|history`. Channels are created by onboarding, so there is no `enroll`; `assign` points a Channel at another Agent (for example, a new topic at an existing Agent instead of the one onboarding made) and closes the old Session. A disabled Channel ignores messages and is not onboarded again. `history <channel>` prints the Channel's latest messages (`-n <count>`), with time, direction, and origin.

**Done when:** e2e tests cover listing, reassignment (the new Agent's first turn carries over the Channel's history), disabling, and history, and two Channels assigned to different Agents keep separate Sessions.

### 2.11 End-to-end verification and smoke-test docs

Add an e2e test through the fake adapter and fake runtime: a forum group is allowed, two topics are created and onboard two Agents, the General topic and a direct chat reach the main Agent, and every Channel continues its Session across a daemon restart. Switching an Agent's provider then starts a fresh Session whose first turn carries the Channel's history. Document the recommended Telegram setup and how to run the Claude and Codex smoke tests under the service's OS account.

**Done when:** the Phase 2 exit criteria are covered by automated or documented, repeatable tests.

### Phase 2 exit criteria

In an allowed forum group, creating a topic onboards a new Agent that answers there; two topics keep separate contexts while working in the same shared folder, and an Agent with its own folder works there. The General topic and a direct chat with the bot, neither of which has a topic ID, reach the main Agent in separate Sessions. A follow-up resumes the right provider session after a process restart; editing the provider or folder starts a fresh Session that carries over the Channel's recent messages, while a new model or effort continues the conversation. Each Channel's history holds the text sent and received there, and nothing else. Messages from a chat that is not allowed never invoke a runtime or create an Agent and get only the pairing hint. Codex and Claude subscription sign-ins each have a documented SDK smoke test under the OS account running the service.

## Phase 3 — durable workflows

Add manual Triggers, Workflow Runs, and the bounded executor. Add schedule Triggers with timezone-aware `next_run_at` calculation and a polling tick. Create pending runs and advance schedules transactionally. Define missed-run coalescing, retry policy, cancellation, and startup recovery. Let a Workflow read Channel history as its input.

### 3.1 Workflow and Trigger definitions

Add Workflow and Trigger services and `pero workflows ls|show|create|edit|disable|enable` and `pero triggers ls|add|remove|disable|enable`, validating Agent references and trigger config with Zod. Schedule Triggers take a cron expression, validated with `croner`, and an IANA time zone that defaults to the `timezone` setting; their next run is computed from 3.3. No execution yet.

**Done when:** e2e tests cover creating, editing, and disabling definitions, and invalid references are rejected.

### 3.2 Manual runs and the bounded executor

`pero workflows run <name>` creates a `pending` Workflow Run with a unique trigger key through the Workflow's enabled manual Trigger, then waits for the run and prints its answer (`--no-wait` returns at once). A bounded in-process executor claims it while fewer than `max-concurrent-runs` run, snapshots the Agent's execution settings and the input, and runs it through `AgentManager` in an isolated context (no Session, history, or tool approver), with at most one active run per Workflow. Record `completed` or `failed` with result or error; a run Pero stops mid-way is recorded `interrupted`.

**Done when:** tests show the global limit and one-run-per-Workflow rule hold, the snapshot is unaffected by later Agent edits, and a run never touches a Channel's interactive Session.

### 3.3 Schedule calculation

A pure function computes a schedule Trigger's next occurrence (cron expression and IANA timezone, added in 3.1) with an explicit daylight-saving policy: a local time the clocks skip runs the moment they jump, a repeated local time runs once at its first occurrence, and times that land on the same instant are one run. Adding or enabling a schedule sets `next_run_at` from now, disabling clears it, and startup fills it for enabled schedules that have none; a schedule no date matches is refused.

**Done when:** unit tests cover time zones, DST gaps and overlaps, and month/year boundaries.

### 3.4 Scheduler tick

Add a `@nestjs/schedule` polling tick, every 10 seconds and once at startup, that, in one short transaction per Trigger, creates the pending run and advances `next_run_at`. The run's trigger key is the Trigger and the due time it read, so however often a time is polled the unique key allows one run. Missed intervals coalesce to one catch-up run that records the skipped count (`skipped_count`), as do times that come due while that Trigger's previous run is still pending. A schedule whose Workflow or Agent is disabled advances without a run.

**Done when:** tests show concurrent or repeated polls create one run per occurrence, and a daemon started after downtime creates exactly one catch-up run.

### 3.5 Recovery, retry, and cancellation

On startup, re-queue `pending` runs and mark leftover `running` runs `interrupted`, retrying only when the Workflow's policy allows: `--max-attempts <n>` (default 1) on `pero workflows create|edit`, with each retry a new run keyed `retry:<run id>`. Add `pero runs cancel <id>`; graceful shutdown requests cancellation once the shutdown timeout passes and leaves unresolved runs `running` for recovery.

**Done when:** tests show an interrupted run is visibly recorded and handled according to its policy, and cancellation reaches the runtime.

### 3.6 Channel history as Workflow input

A Workflow can read Channel history, so an Agent can review conversations on a schedule. For example, an `english-coach` Agent can read the day's chats every evening and suggest improvements.

Add optional history input to Workflows as `history_json`, validated with Zod. It chooses:
- **Channels:** all of them, or a list of Channel IDs.
- **Messages:** only the ones people wrote, or the Agents' replies too; Pero's own notices never.
- **Window:** since the previous successful run (the default; a first run reads the last 24 hours), or a fixed number of hours.

How a run reads its window:
- **Fixed on claim:** when the executor claims a run, it fixes the end of the window and records the window in the run's snapshot. Mark the window's end by message ID: `created_at` has whole seconds, so a time alone can split or repeat messages at the boundary.
- **Retries and later runs:** a retry reads the same messages, and is claimed before other pending runs of its Workflow. The next run starts where the latest completed one ended, with no gaps and no overlaps. A run that fails or is cancelled leaves its messages for the next run.
- **Rendering:** the messages become a transcript: local time, Channel title, who spoke, and text. It goes into the input template's `{{history}}` placeholder, or after the input when there is none.
- **Size limit:** a character budget drops the oldest messages first, and the transcript notes that it did.
- **Empty windows:** a run whose window has no messages completes without invoking the Agent and records that it was skipped. A Workflow can opt out of this and run anyway.
- **CLI:** `pero workflows create|edit` set and clear the history input: `--history`, `--history-channels`, `--history-messages`, `--history-hours` or `--history-since-last-run`, `--run-when-empty`, and `--no-history`.

**Done when:** tests show:
- consecutive runs cover adjacent windows;
- a retry reads the same messages;
- the Channel filter and direction filter hold;
- the budget keeps the newest messages;
- an empty window skips the Agent unless the Workflow opts out.

### Phase 3 exit criteria

A missed scheduled run is found after restart; duplicate polls create one run per trigger occurrence; an interrupted run is visibly recorded and handled according to its policy. A scheduled Workflow reads each message in its Channel history window exactly once across runs.

## Phase 4 — notifications and operations

Add Workflow notification targets, durable Notification records, Telegram delivery, retry state, and delivery diagnostics. Expose run inspection, manual retry/cancel, and Workflow/Trigger management through owner-only CLI commands. Document install, credentials, storage, backup, and restore.

### 4.1 Notification targets and records

Add `pero workflows notify <workflow> <channel>`, and `--remove` to stop; `workflows show` lists the Channels a Workflow notifies. When a run finishes, create its Notification records in the same transaction as the final run status, one `pending` per target, due at once, with the rendered text as its payload:
- **Completed:** the Agent's answer, headed by the Workflow's title or name.
- **Failed, or interrupted without a retry:** why, so a broken schedule does not go unnoticed. An interrupted run that is retried leaves it to its retry.
- **Cancelled, or skipped for an empty history window:** nothing.

Every place a run ends goes through one path. Notifications are created in a savepoint: if that fails, the run is still recorded, without them.

**Done when:** tests show a completed run and its Notifications commit together, and a Notification failure never keeps a run `running`.

### 4.2 Delivery worker

A delivery tick every 5 seconds dispatches due `pending` Notifications through the Channel adapter, one at a time:
- **Attempts:** each attempt records the attempt count and, when it fails, `last_error`. Failed attempts retry after 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 4 h, 8 h, and 8 h. After ten attempts, about a day, the Notification is `failed` and stays visible.
- **Lease:** claiming an attempt sets the next attempt time first, so a Pero that stops mid-send tries again only after the backoff. Delivery is at least once.
- **Allowlist:** a Notification to a chat that is no longer allowed fails at once without sending. A disabled Channel still receives Notifications.
- **History:** a delivered Notification records `provider_message_id` and, in the same transaction, a Channel history message with origin `workflow`, linked to the Notification. A unique index records each Notification once.
- **Next turn:** the next interactive turn in that Channel places the Workflow messages posted since the Channel's previous person's message before its input, so the owner can reply to one, such as by asking about a suggestion in the English topic.
- **Carry-over:** a fresh Session's carry-over includes `workflow` messages. Workflow history windows (3.6) leave them out, so a Workflow never reads its own answers back.

**Done when:** a simulated Telegram outage leaves the Notification retrying and delivers it once Telegram recovers, without creating another Workflow Run; a delivered Notification appears in the Channel's history once, and the next turn there receives its text.

### 4.3 Operations commands

Add `pero runs ls|show|retry|cancel` and `pero notifications ls|show|retry` with delivery diagnostics. Add the `history-retention-days` setting: unset keeps all history, otherwise an hourly task, which also runs at startup, deletes older messages, so a changed setting applies within the hour even on a machine that sleeps. Runs and Notifications keep their text.

**Done when:** e2e tests cover inspection and manual retry of both runs and Notifications, and history older than the retention setting is deleted.

### 4.4 Operations documentation and restore drill

Document install, provider and Telegram credentials, data layout, message history (what is stored, retention, and that backups contain it), backup, and restore. Extend the 1.11 restore test to cover definitions and resumable Sessions, and document backing up the working folders.

**Done when:** a documented backup/restore on a fresh machine brings back definitions and resumable Sessions, with working folders restored from the owner's own backup.

### Phase 4 exit criteria

A Workflow can notify a configured topic; a daily Workflow can review the previous day's chats and deliver suggestions to a chosen topic, where the owner can reply to them; a temporary Telegram delivery failure remains visible and retries without creating duplicate Workflow Runs; restore brings back definitions and resumable sessions.

## Configured by files: strategy

Phases 5–10 replace definitions in SQLite with files in a workspace, as the [configuration reference](./CONFIGURATION.md) describes. The switch touches almost every module that reads an Agent, a Workflow, or a setting. Thirteen services import the `Agent` entity alone. To keep PRs small, the work runs in this order:

1. **New layout first** (phase 5). Workspace, `.env`, and `config.yaml` replace the data directory and the pieces of SQLite that belong on the host. Behaviour stays the same otherwise.
2. **Loader next, used by nothing** (phase 6). The note parser, the snapshot, reloading, and `pero check` are built and tested on their own.
3. **Branch by abstraction** (phase 7). Every consumer reads definitions through one `Definitions` interface, still backed by SQLite. State tables switch from IDs to names. `pero migrate` writes an installation's definitions as notes.
4. **Switch one domain at a time** (phases 8 and 9). Agents, then Workflows, move from the SQLite-backed `Definitions` to the note-backed one. Each phase ends by dropping the tables it replaced.
5. **Ship** (phase 10). Example workspace, docs, release.

**Existing installations keep working until the release.** Until phase 10, a legacy data directory (`--data-dir`, `PERO_HOME`, or an existing `~/.pero` with no workspace found) still starts. From phase 8 on, it needs `pero migrate` first, and says so. The version that ships this is `0.2.0`. Removed commands become stubs that say what to edit instead, and a later release removes the stubs and the legacy data directory.

**What can run in parallel:** 5.x and 6.1–6.2 don't depend on each other. 6.3 and later need the workspace and `config.yaml` (5.1–5.3a), since they find the settings folder through them. Phase 7 needs 6.2. Phases 8 and 9 are sequential, since both change the `Definitions` implementation.

```text
5.1 ─ 5.2 ─ 5.3a ┬─ 5.3b ─ 5.4 ─ 5.5 ─┐
                 │                    │
6.1 ─ 6.1b ─ 6.2 ┴─ 6.3 ─ 6.4 ─ 6.3b ─┴─ 7.1a ─ 7.1b ─ 7.2 ─ 7.3 ─ 7.4 ─ 8.1 … 8.5 ─ 9.1 … 9.4 ─ 10.1 ─ 10.2 ─ 10.3
```

## Phase 5 — workspace

Replace the data directory with the workspace layout from the [configuration reference](./CONFIGURATION.md#the-workspace): `.pero/` for state and host configuration, `.env` for the token, `config.yaml` for the data folder and allowed chats. Agents and Workflows still come from SQLite.

### 5.1 Workspace discovery and layout

Add workspace resolution to the bootstrap configuration (`src/config/bootstrap-config.ts`), tried in this order:

1. `--workspace`/`-w` on any command, or the legacy `--data-dir` (not both).
2. `PERO_WORKSPACE`, then the legacy `PERO_HOME`.
3. The nearest folder containing `.pero/`, from the current folder upward. The home folder itself never counts: its `.pero` is the legacy data directory.
4. `~/workspace` if it contains `.pero/`.
5. The legacy data directory `~/.pero`.

An explicit choice always wins over a workspace found from the current folder, and a workspace is identified by its real path, so a symlinked folder is the same workspace. The development scripts use the checkout as a workspace (`-w .`).

`dataDirLayout` knows the workspace: its state is `.pero/pero.sqlite`, `.pero/logs/`, `.pero/run/`, as in a data directory. Startup writes `.pero/.gitignore`, which ignores everything in `.pero/` except `config.yaml` and `.gitignore`. When the socket path would exceed the Unix limit, the socket moves to `$XDG_RUNTIME_DIR/pero-<hash>/` (or the temp folder), and commands find it through the process metadata.

`pero status` shows the workspace, or the data directory marked `(legacy)`.

**Done when:**
- Unit tests cover the precedence and the upward search, including a workspace inside a Git repository, a symlinked folder, and a symlinked home folder.
- A daemon started in a temporary workspace creates the layout and the `.gitignore`.
- A deep workspace path still gets a working socket.
- A legacy data directory starts as before.

### 5.2 `.env` credentials

Pero's secrets move to `<workspace>/.env` (`src/config/env-file.ts`):

- **Read:** a small dotenv parser (`KEY=value`, `export`, `#` comments, optional quotes). Reading is refused, with a `chmod 600` hint in the `telegram` component, when group or others can read the file. A variable in the environment wins.
- **Write:** `pero settings set telegram-bot-token` and the interactive `pero run` still go through the daemon, which writes the token atomically with mode `0600`, keeping other lines and comments.
- **`.gitignore`:** writing the token also makes sure the workspace `.gitignore` lists `.env`.
- **Git check:** when the workspace is in a Git repository, `pero status` reports an error if Git tracks `.env` or wouldn't ignore it (`git ls-files`, `git check-ignore`). The CLI runs the check itself, so it works whether or not Pero runs, and `pero check` can reuse it.
- **Legacy:** `secrets/telegram-bot-token` is still read and written, in a legacy data directory only. A workspace has no `secrets/`, and its backups carry no token.

`TelegramCredentials` changes accordingly; the token source `env-file` shows as `set (.env)`.

**Done when:**
- Tests cover parsing, precedence over the file, the permission refusal, and writing that keeps other lines and comments.
- The `.gitignore` line is added once.
- The Git check catches a tracked `.env`.
- The token never appears in logs, `status`, or `settings show`.

### 5.3a `config.yaml`: data folder and allowed chats

`config.yaml` lives in the state directory: `.pero/config.yaml` in a workspace, `<data dir>/config.yaml` in a legacy data directory, so both take one code path. `src/config/host-config.ts` parses it with `yaml` (YAML 1.2, integers as bigints so large chat IDs keep every digit) against a strict Zod schema for `data`, `settings`, and `telegram.allowed-chats`. Errors name the file, line, key, and reason. Writes go through the `yaml` document API: each one reads the file again, changes only its own lines, and replaces the file atomically, so comments, ordering, and hand edits survive.

- **`data`** replaces the `default-working-directory` setting. On first start, a missing `config.yaml` gets `data:` from that setting (relative to the workspace when inside it, absolute in a legacy data directory), or `data`. At every start the resolved folder is copied into the settings row, which the rest of Pero reads until 8.5 drops it. A workspace's `data/` is created when missing; any other missing folder stops startup in a workspace and only warns in a legacy data directory.
- **`telegram.allowed-chats`** replaces the `allowed_chats` table. At startup, any rows are added to the file (a union by chat ID) and then deleted, so the import happens once and a restored older database is picked up too. The table itself is dropped in 9.4. `AllowedChatsService` keeps its interface, backed by the file; chat kinds come from the ID's sign, and titles seen in messages stay in memory, so Pero writes the file only when the list changes.
- **`pero telegram allow`/`deny`** and `settings set default-working-directory` go through the daemon, which edits the file.
- **A chat ID migration** moves the Channel, then rewrites that entry's `id` (or drops it when the new ID is already allowed).
- **An invalid `config.yaml`** stops startup with the file, line, key, and reason.
- **Backups** (format 2) include `config.yaml`; format 1 backups still restore.

**Done when:**
- `allow`/`deny` keep comments.
- Chat migration updates the file.
- Existing `allowed_chats` rows and the default working directory are carried into a new `config.yaml` exactly once.

### 5.3b Live reload, and `allow`/`deny` without the daemon

- **The daemon rereads `config.yaml` every 10 seconds** (a size and mtime check; Pero's own writes don't count). A chat added or removed by hand applies from its next message, and the Telegram status catches up: the chat count, and the bot's standing in each group added.
- **`pero telegram allow`/`deny` edit the file directly** when Pero isn't running, without loading the daemon's dependencies, and say the change applies when Pero starts.
- **`data` and `settings` changes need a restart.** A new `config` component in `pero status` says so while the file differs from what Pero runs with. `settings set default-working-directory` still applies at once.
- **At runtime, an invalid edit** (or a deleted file) is logged once per version and shown by `config`, and the last valid version stays in use.

**Done when:**
- A chat allowed by hand is served from the next look, and one removed stops being served.
- `allow`/`deny` work without Pero running and keep comments.

### 5.4 `pero init` and first run

`pero init [dir]` (default: `--workspace`, then the current folder) writes the skeleton:

- `.gitignore` with `.env`, or the line added to an existing one
- `.pero/` with its `.gitignore`, and `.pero/config.yaml` with commented defaults
- in the settings folder (`data/Settings/` unless `config.yaml` names another data or settings folder): `Pero.md`, `Agents/Main.md`, and `Agents/_Template.md`, each with commented example properties that the phase 6 note readers accept
- an empty `Workflows/`

It never overwrites a file, and prints what it created, updated, and kept. It refuses the home folder and a legacy data directory. These notes aren't read until phase 8. They exist now so a workspace made today stays valid.

Discovery no longer creates `~/.pero`: it is used only when it exists. With no workspace found, an interactive `pero run` offers `pero init` in the current folder (or `~/workspace` from home). This replaces today's working-folder question, which a workspace no longer needs, since its `data/` folder is set. A non-interactive run prints the `pero init` command and exits 1; `pero status` exits 3 with the same hint.

**Done when:**
- Running `init` twice changes nothing the second time.
- `init` inside a cloned workspace fills in only missing files.
- An interactive first run from home ends with a running Pero in `~/workspace`.
- The packed-install job starts from `pero init ~/workspace`.

### 5.5 Backup and restore of a workspace

- **`pero backup`** archives the database snapshot and `config.yaml`, as before; a legacy data directory's backup still has its `secrets/`. `.env`, logs, and `run/` are never included, so a workspace's backup has no token.
- **`--include-data`** adds the data folder under `data/`: its regular files and folders, never links, and not `.pero/` or `.env` should they be inside it. The destination must be outside it. Only such a backup is format 3, with `includesData` in the manifest, so an older Pero restores every other backup and asks for an upgrade for this one. Staging moves next to the destination, which has room for it, instead of a temporary folder that may be in memory.
- **`pero restore <file>`** into a workspace (found, or `-w`, created when missing) needs a `.pero/` without `pero.sqlite*`. It extracts next to `.pero/` and copies each file without overwriting, the database first, so a daemon starting meanwhile stops it with nothing changed.
  - **`config.yaml`:** the workspace's own is kept, and the chats only the backup's allowed are listed; `--replace-config` takes the backup's. Nothing is said when both are the same.
  - **Data:** into the folder the workspace's `config.yaml` names, keeping each file already there, with the numbers copied and kept.
  - **Legacy backups:** their token goes to `.env` unless it has one, with the `.gitignore` line.
  - **Missing folders** are checked against the workspace's `config.yaml`, not the path the backup recorded; a legacy backup's default `data/` isn't reported, since it never had one.
- **Into a legacy data directory**, restore is unchanged, and refuses a backup with a data folder.
- **Found while building:** a workspace restored at another path keeps working, but each Channel starts a fresh Session with its recent messages, since a provider conversation belongs to its folder. The drill restores at the same path, as on a new machine.

**Done when:**
- A backup restores into a freshly cloned workspace, and Pero starts with the same history and runs: `test/restore.e2e-spec.ts`.
- `--include-data` round-trips the data folder: `test/restore.e2e-spec.ts`, `test/cli.e2e-spec.ts`.
- A legacy backup restores into a workspace, its token in `.env`: `test/cli.e2e-spec.ts`, the packed-install script.
- The packed-install CI job runs `init`, `run`, a Git commit check, `backup --include-data`, `stop`, and `restore` into a `git clone`, then a legacy backup restored into a data directory and a workspace.

### Phase 5 exit criteria

- `pero init ~/workspace && cd ~/workspace && pero run` sets up a working Pero with its state in `.pero/` and its token in `.env`.
- Committing the workspace commits `config.yaml` and nothing secret.
- Allowed chats can be changed by editing `config.yaml`.
- Backups restore into a cloned workspace.
- A legacy data directory still works unchanged.

## Phase 6 — settings loader

Build the note loader as a pure module, `src/settings-files/` (no Nest or TypeORM, like `src/config/`), and run it in the daemon. Nothing reads its snapshot yet.

Each problem is reported as `{ file, property, message }`: `file` is the note's path inside the settings folder, and `property` is null for a problem with the whole note.

### 6.1 Note parsing

Add the `yaml` dependency (5.3 needs it too).

- **Frontmatter:** only when the first line is `---`, up to the next `---` line. It's parsed with `yaml` as YAML 1.2, so `12:00` and `yes` stay strings. It must be `name: value` lines. A missing closing line, duplicate keys, and syntax errors are errors naming the line.
- **Body:** everything after the frontmatter, trimmed. An empty body counts as none.
- **Ignored files:** anything but `.md`, and any file or folder whose name starts with `_` or `.` (`_Template.md`, `.obsidian/`).
- **Kinds by location:** `Pero.md` at the root, Agents anywhere under `Agents/`, Workflows anywhere under `Workflows/`. Any other note in the settings folder is an error, so a note in a misspelled `Agent/` folder isn't silently skipped.
- **Names:** the name comes from the file name through `src/config/slug.ts`, and the title is the file name without `.md`. A file name with no letter or digit is an error.
- **Property keys:** unknown ones are errors with a "did you mean" suggestion. `tags`, `aliases`, and `cssclasses` are allowed and ignored.

**Done when:**
- An empty note, frontmatter without a body, and a body without frontmatter are all valid.
- Tests cover the errors above, file names in Cyrillic and with accents, subfolders, and ignored paths.

### 6.1b Note schemas

**Zod schemas**, reusing today's value schemas in `src/config/` (provider options, permissions, time zone, cron, history):
- `Pero.md`
- Agent notes
- Workflow notes

**Workflow schedules:** `day`/`hour`/`minute` become a cron expression, and `trigger` is inferred from them. Lists and single values are accepted for `topics`, `channel`, `day`, and `hour`. `cron` with `day`, `hour`, or `minute` is an error. A `manual` Workflow may keep its times, which then don't run.

**Done when:**
- Unit tests cover every property in the [configuration reference](./CONFIGURATION.md): its default, invalid values, and the schedule mapping (`sunday` 12:00 → `0 12 * * 0`; `weekdays` with `[9, 18]` → `0 9,18 * * 1-5`).

### 6.2 Snapshot and references

`buildSnapshot(files, lookups)`:

1. **Scan the settings folder:** recursive, `.md` only, skipping ignored files and never entering ignored folders, with duplicate names reported against both files.
2. **Parse each note** (6.1, 6.1b).
3. **Resolve references** into an immutable snapshot of `defaults`, `agents`, `mainAgent`, and `workflows`:
   - `main-agent`
   - Workflow `agent`
   - the default Agent from `channel`
   - `topics` claimed twice
   - each Agent's `effort` against its provider, after `Pero.md`
4. **Leave out broken notes.** A broken note is left out along with only the notes that depend on it. A broken `Pero.md` means all defaults, not missing Agents. A topic claimed twice is an error on both notes, which still load, and the topic goes to neither.

Topic titles in `channel` and `history-channels` resolve through an injected lookup. Without one, as in CI, they're checked for syntax only.

**Done when:**
- Tests build snapshots from fixture folders: subfolders, ignored files, duplicate names, a topic claimed twice, a missing main Agent (the default `Main` is then required once a primary Channel needs it), and a Workflow whose Agent is broken.
- Every error names the file and property.

### 6.3 `pero check`

Needs 5.1–5.3a for the workspace and `config.yaml`, and 5.2 for the `.env` checks.

Without Pero running, `pero check` resolves the workspace, loads `config.yaml` and the notes, and prints errors grouped by file. It checks the `.env` permissions and the Git rules from 5.2. Exit 1 on any error. It opens no database, so it runs in CI on a workspace repository. It says that topic titles weren't checked. `--json` prints the errors for tools.

**Done when:**
- `check` passes on the `pero init` skeleton and fails with the expected messages on fixtures.
- It works without the daemon, including `--json`.

### 6.4 Reloading in the daemon

Add a `SettingsNotesModule` whose `SettingsNotes` service holds the current snapshot. It rescans every 10 seconds, on its own interval: what reacts to a change (schedule reconciliation in 9.2) listens for the change event, so it needn't share the scheduler's tick.

1. **Stat** every note.
2. **Reparse** only the changed ones.
3. **Debounce:** a note is reported broken only after two failing scans with the same size and mtime.
4. **Keep last good versions** in memory while the daemon runs. They aren't kept across restarts: a note still broken after a restart loads once it's fixed.
5. **Swap in** the new snapshot and log the changed files.

It also tells listeners of each new snapshot with the notes that changed, and adds a `settings` health component (`ok`, or `degraded — N notes have errors`) to `pero status`, next to 5.3's `config` component for `config.yaml`. A legacy data directory has no notes and no `settings` component.

**Done when:**
- An edited note shows in the snapshot within one tick.
- A note caught mid-write isn't reported.
- A note that becomes broken keeps its last good version and is reported.
- A deleted note leaves the snapshot.
- 500 notes rescan in well under a second.

### 6.3b `pero check` through the daemon

With Pero running, `pero check` asks the daemon through a new `check` control request. The daemon checks the notes as they are on disk now, without the debounce or last good versions, and adds topic resolution against the `channels` table: a title that matches no topic lists the topics Pero has seen, and one that matches several asks for `<chat title>/<topic title>`.

**Done when:**
- It works with and without the daemon.
- Topic errors appear only with the daemon.

### Phase 6 exit criteria

- `pero check` validates any workspace with or without Pero, including in CI.
- The running daemon keeps an up-to-date snapshot of the notes, and `pero status` reports broken ones.
- Behaviour is otherwise unchanged.

## Phase 7 — definitions behind one interface

Make the switch small: consumers stop reading definition tables directly, and state stops pointing at definition rows by ID.

### 7.1a The `Definitions` interface: Agents and defaults

Define `Definitions` in `src/definitions/`, a read-only interface. It is an abstract class, the injection token, and its methods are async so either store can serve them:

- `defaults()`, including the data folder and the shared instructions
- `agent(name)`, `agents()`
- `mainAgent()`
- `onChange(listener)`

Its types name no store: no row IDs and no timestamps. Its first implementation, `SqliteDefinitions`, reads today's tables afresh on each call. The create and edit services still write them, and tell `onChange` listeners once their writes commit.

State still points at definition rows by ID until 7.2 (and a Channel's Agent until 8.2). `DefinitionIds` maps those IDs to names and back, so `Definitions` itself knows names only.

Route every Agent and defaults consumer through it:

- `AgentManager` and `agent-resolution.ts`
- the Channel router stages and onboarding, whose Agent writes move into `AgentsService`
- `ProviderAuthService`, which lists the providers in use
- the history services
- the Agent and Channel views, which drop the Agents' `createdAt` and `updatedAt`, since notes have none
- `config.yaml`'s data folder and backups

Joins from state rows that only turn an ID into a name for display, such as a message's Agent, stay until 7.2 replaces the IDs.

**Done when:**
- A test checks that no module outside `src/definitions/`, `src/persistence/`, and the create/edit services imports the `Agent` or `Settings` entities, apart from the Workflow side 7.1b routes.
- The full test suite passes unchanged, apart from wiring and view fixtures.

### 7.1b The `Definitions` interface: Workflows

Add `workflow(name)` and `workflows()`. A Workflow's definition names its Agent and holds its input, history input, notification targets (Channel IDs, since Channels are state), attempts, and whether it's enabled; schedules come in 7.3. `DefinitionIds` maps Workflow row IDs, which runs still hold until 7.2, to names and back. `TriggersService` keeps the `triggers` rows, which are state as much as definitions, until 7.3 replaces them: `triggers.service.ts` exports the few reads and writes of them that runtime code needs. Route the rest through `Definitions`:

- `WorkflowExecutor`, `WorkflowRuns`, and `ScheduleTick`
- run notifications, which go to the Channels the Workflow notifies as it is defined when the run ends
- the Workflow views, which drop `createdAt`, `updatedAt`, and `concurrencyPolicy` (only `serial` exists, and notes have no such property)

A Workflow or Agent that is gone, which only notes make possible, is treated like a disabled one: its runs fail or aren't retried, and its schedules pass without a run.

**Done when:**
- No module outside `src/definitions/`, `src/persistence/`, and the create/edit services imports the `Agent`, `Workflow`, `Trigger`, `WorkflowNotificationTarget`, or `Settings` entities.
- The full test suite passes unchanged, apart from wiring and view fixtures.

### 7.2 Names instead of IDs in state

A migration switches state tables from IDs to names:

- **`sessions`** gets `agent_name` in place of `agent_id`. The partial unique index becomes `(channel_id, agent_name)` where `status = 'active'`.
- **`messages`** gets `agent_name`.
- **`workflow_runs`** gets `workflow_name`, and the unique key becomes `(workflow_name, trigger_key)`.
- **`workflows`** gets `agent_name` in place of `agent_id`. This is a definition table, but its Workflows must survive `agents` being dropped in 8.5, before they move to notes in 9.1.

The new columns are filled from the current rows, and the foreign keys to `agents` and `workflows` go. Channels keep `agent_id` until 8.2, and Triggers and notification targets keep `workflow_id` until 7.3 and 9.4; `DefinitionIds` serves only those. The execution snapshot (`src/workflows/execution-snapshot.ts`) drops the Agent's row ID: it already records the input the run sent and the Agent name. `pero runs show` and `ls` need no Workflow row, and `--workflow` in `runs ls` and `notifications ls` matches runs by name, so the runs of a Workflow that is gone still list. A name that neither a Workflow nor any run has is still an error.

**Done when:**
- The migration is tested against a database from the current release, with Sessions, messages, and runs all mapped.
- A run whose Workflow row is gone still shows fully.
- Sessions resume across the migration.

### 7.3 Schedule state keyed by name

Add a `schedules` table: `workflow_name`, `fingerprint` (a hash of the cron expression and time zone), `next_run_at`, `last_run_at`. It is filled from the enabled schedule Triggers. `ScheduleTick` reads schedules from `Definitions` and their state from `schedules`:

- **Fingerprint changed:** `next_run_at` is computed afresh.
- **Schedule removed:** its row is dropped.

Trigger keys become `schedule:<workflow>:<due time>`, and a time that comes due while the Workflow's previous scheduled run waits adds to that run's skipped count. A Workflow with several schedule Triggers keeps one row per Trigger until `pero migrate` splits them (7.4).

**Done when:**
- Recovery and catch-up tests pass on the new table.
- Changing a schedule recomputes the next run without a catch-up.
- Removing one drops its state.
- No run is lost or repeated across the migration.

### 7.4 `pero migrate`

`pero migrate <workspace>` converts an installation into a workspace, as [the CLI reference](./CLI.md#command-contract) and [Operating Pero](./OPERATIONS.md#upgrading-from-01) describes:

1. **Copies the old database while holding the daemon lock, then migrates and reads the copy, in-process.** The CLI otherwise never opens a database. This is a documented exception, like `restore` touching files, and it refuses while a daemon answers for that data directory. The source is never opened, since even a read-only open of a WAL database can create files next to it, and a 0.1 database needs the 7.2 and 7.3 migrations before it can be read.
2. **Checks before writing:** topic titles that would lead to two Agents, and notes that exist with other content, stop the command before anything is written.
3. **Writes the notes:** `Pero.md`, one note per Agent (with `topics` from its Channel assignments), and one note per Workflow (splitting several schedules into several notes). Names are kept: a note is named after its title only when that gives the same name, and after the name otherwise. An Agent without its own model or effort takes `Pero.md`'s, and the command says so.
4. **Writes `config.yaml` and `.env`**, and runs `pero init` for the rest of the skeleton, without the template `Agents/Main.md`.
5. **Moves the copied database** into `.pero/`, last, so a migration that stopped part way runs again. A split Workflow is split in the copy too: one Workflow row per schedule, under the notes' names, each with its schedule's saved times, so phase 9 needs no mapping.
6. **Runs `pero check`**, resolving topic titles against the copied Channels.

The old installation is left untouched.

**Done when:**
- Migrating fixture databases gives notes that `pero check` passes, and whose snapshot describes the same Agents, defaults, topic routes, Workflows, schedules, and notification targets as the database (compared in a test).
- Conflicting topic titles stop the command with a list.
- The source directory is byte-for-byte unchanged.

### Phase 7 exit criteria

- All runtime code reads definitions through `Definitions`.
- State refers to Agents and Workflows by name.
- Every existing installation can be converted to a workspace with `pero migrate`, and its snapshot matches its database.

## Phase 8 — Agents from notes

Switch Agents, defaults, and topic routing to notes. From 8.1, a legacy data directory that hasn't been migrated has its `settings` component degraded, saying to run `pero migrate`, and its Agents and settings can't be changed from the CLI; it keeps answering from SQLite until 8.5 drops the tables.

### 8.1 Agents and defaults from the snapshot

Add `FileDefinitions` for Agents and defaults, backed by the 6.4 snapshot, and make it the implementation used. Workflows still come from SQLite until 9.1.

- **Defaults from `Pero.md` apply live.**
- **An Agent whose provider or folder changes** starts a fresh Session on its next turn, per the existing Session policy.
- **`pero agents ls`/`show`** show the note path, effective values with where each comes from (note or `Pero.md`), topics, and the note's errors.
- **Stubs:** `pero agents create`/`edit`/`enable`/`disable` and `pero settings set`/`unset` (except `telegram-bot-token`) name the note to edit.
- **`pero settings show`** reads `config.yaml` and `Pero.md`.
- **Found while building:**
  - **A legacy data directory keeps `SqliteDefinitions`** until 8.5, read-only: the stubs apply there too and say to run `pero migrate`, and its `settings` component is degraded with that hint. The daemon still takes Agent and settings changes over the control endpoint there, for the interactive setup and tests. In a workspace it refuses them, naming the file to edit, since they would change nothing.
  - **`agents` rows only anchored Channels** until 8.2, since `channels.agent_id` still pointed at one. A primary Channel is anchored to the row named after `Pero.md`'s `main-agent`, created when missing, through a new `Definitions.mainAgentName()`, which names the main Agent even before its note exists. `pero channels assign` anchors any Agent a note defines. Onboarding still creates a row for a new topic; until 8.3 writes notes, that topic is answered only once a note of that name exists, and each message it gets logs the note to add.
  - **The snapshot loads on first use** (`SettingsNotes.ready()`), since recovering Workflow runs reads Agents before the daemon's bootstrap hooks run.
  - **The snapshot records the properties `Pero.md` sets**, so `ls`/`show` can tell `Pero.md`'s values from Pero's own defaults.
  - **Which providers health depends on follows every change to the definitions**, since a note's `provider` can change without a command.
  - **Stubs accept any of the old options**, and `src/cli/agent-options.ts` is gone already.

**Done when:**
- Editing an Agent note's body, `model`, or `effort` changes the next turn in the same Session.
- Editing `provider` or `working-directory` starts a fresh Session that carries over history.
- Editing `Pero.md` changes every Agent that doesn't override the value.
- Stubs print the right path.

### 8.2 Topic routing by `topics`

The router chooses the Agent from the snapshot on each message, through a new `Definitions.agentForTopic(title)`:

- **A primary Channel** gets the main Agent.
- **A topic** gets the Agent whose `topics` claims its title.

The change comes with a migration and CLI updates:

- **Migration:** drops `channels.agent_id` and `channels.enabled`.
- **Route changes:** a turn whose route changed closes the old Session, and the new Agent's first turn carries over history.
- **Topics that can't be answered** get one reply saying why: a disabled Agent, a conflict, or a broken note that never loaded.
- **`pero channels ls`/`show`** show the current route.
- **Stubs:** `pero channels assign`/`enable`/`disable`.
- **Found while building:**
  - **`Definitions.route(channel)`** replaces `agentForTopic(title)`. It takes the Channel's ID, whether it is primary, and its title, and gives the enabled Agent that answers or why none does. One method covers primary Channels, and a legacy data directory, which routes by Channel ID.
  - **A legacy data directory keeps its routes in `legacy_channel_agents`.** The migration moves each Channel's Agent name and enabled flag there.
    - `pero migrate` reads that table. It migrates its copy before reading it, and a newer daemon may already have migrated a legacy database, so `agent_id` can't be the source.
    - A legacy data directory routes from it exactly as before: onboarding still creates an Agent per topic and adds its row, and a disabled Channel stays silent.
    - The table goes with legacy data directories, after 0.2.0.
  - **Titles are learned from messages.** Telegram names a topic only in `forum_topic_created`, attached to messages that aren't replies to other messages, so a topic first seen in a reply has no title. The router fills a missing topic title from a later message. It never replaces a known one, since messages carry the title the topic was created with; only a rename changes it. A chat's own title follows each message.
  - **Until 8.3, an unclaimed topic** gets a reply naming the note to add with `new-topics: create-agent`, and goes to the main Agent with `main-agent`. A topic whose title isn't known yet is handled the same way. A missing main Agent note gets a reply too, until 8.3 writes `Main.md`.
  - **"Once" means once per reason, in memory.** Pero replies again when the reason changes, or after the topic was answered in between. A restart may repeat a reply. The reply is sent outside the Channel's history, and the message isn't kept.
  - **The new Agent's first turn closes the other Agents' active Sessions** in the Channel, rather than a command closing them. Otherwise an Agent the topic comes back to would resume its old Session without the messages in between. A turn accepted before the route changed is skipped.
  - **`pero agents show`** lists the Channels that route to the Agent now, found by routing every Channel.

**Done when:**
- Adding a title to an Agent's `topics` moves that topic on its next message.
- A topic claimed twice is answered by neither, with one explanation.
- Disabling an Agent silences its topics.
- General topics and direct chats reach the main Agent.

### 8.3 Onboarding writes notes

Rewrite `ChannelOnboardingService` around notes:

- **An unclaimed topic:** with `new-topics: create-agent`, Pero writes `Agents/<Topic title>.md` from `_Template.md`, with `topics` set, and posts the welcome. With `main-agent`, the main Agent answers.
- **File names:** characters invalid in file names are replaced, and an existing file is never overwritten (`Health 2.md`).
- **A missing main Agent note** is created as `Main.md` the first time a primary Channel needs it.
- **A topic rename** rewrites that title in the claiming note's `topics` through the `yaml` document API.
- **Every note write** is atomic (temporary file, then rename) and logged.
- **No reload wait:** the new note enters the snapshot at once, without waiting for the next scan.
- **Found while building:**
  - **Onboarding decides who answers** through a new `ChannelOnboarding.answer(channel)`, which the router calls on every message instead of routing itself. A topic Pero knew before 8.3, or whose title it learns later, gets its note on its next message, not only on the topic-created event.
  - **One note per topic** comes from a single in-process queue for note writes and renames: whoever writes routes again inside it first, so the topic-created event and first messages write one note between them. The welcome is posted once per Channel, by whoever created the Channel or wrote its note.
  - **New notes are linked into place:** a synced temporary file is hard-linked to the note's path, which fails when it exists, so a note is never replaced and never seen half written; where hard links aren't supported it is created in place with `wx`. A rename rewrites the note with the existing `writeFileAtomic`. `SettingsNotes.refresh()` rescans after any scan under way, so the note is in the snapshot when the write resolves.
  - **File names:** `/ \ : * ? " < > |`, control characters, and the characters Obsidian links can't hold (`# ^ [ ]`) become spaces, and a leading `_` or `.`, which would hide the note, is dropped. A title left with no letter or digit gives `Topic <id>.md`. Numbering (`Health 2.md`) skips files that exist and names any Agent note already has, in subfolders and broken notes too; the title is shortened so the numbered names stay apart within the 64-character name limit.
  - **The template:** `topics` is added after the template's properties, since a leading comment belongs to the first property in YAML. A template whose properties don't parse, or whose note would have errors, is left out with a warning, and the note gets `topics` alone, so the topic is answered at once. Pero writes one note per title while it runs; if that note is still there and doesn't answer, it doesn't write another.
  - **The main Agent's note** is written as `agentNoteFor(main-agent)` (`Main.md` for the default), only for a primary Channel, and never when an Agent note of that name exists anywhere, even one with errors; that case keeps 8.2's reply.
  - **Renames** keep the old title too while another topic Pero knows has it, since `topics` names titles, not topics. The note is left alone when another Agent, or several notes, claim the new title: the topic then goes where the notes say.

**Done when:**
- A created topic yields exactly one note even when the topic-created event and the first message race.
- The template's properties and body are used.
- A rename keeps the topic on its Agent, and keeps the note's comments and body.
- `main-agent` mode writes nothing.

### 8.4 Protecting the settings folder

Today Claude `ask` Agents run in `acceptEdits` mode, which approves edits in the working folder without asking Pero. Replace it with Pero's own policy in `canUseTool`:

- **Edits in the working folder** are allowed without asking, except paths under the settings folder, resolved through symlinks.
- **Edits under the settings folder** ask in the Channel.
- **In Workflow runs,** where no one can approve, they are refused.

`bypass` and Codex are unchanged. The Codex limitation is documented.

- **Found while building:**
  - **The permission mode is `default`.** `acceptEdits` also ran `mkdir`, `touch`, `rm`, `mv`, `cp`, and `sed` in the folder without asking, another way into the settings folder, so shell commands now always ask. Claude Code still reads in the folder without asking; every other tool reaches `canUseTool`.
  - **Claude Code's, Git's, and the shell's own files keep asking** (`.claude/`, `.git/`, `.vscode/`, `.idea/`, `.mcp.json`, `.claude.json`, `.gitconfig`, `.gitmodules`, shell profiles, `.ripgreprc`), as Claude Code did under `acceptEdits`. Allowing every edit in the folder would otherwise let an Agent add hooks or allow rules to `.claude/settings.local.json` unasked.
  - **Paths:** `Edit`, `MultiEdit`, `Write`, and `NotebookEdit` count as edits. A path is resolved against the working folder with a leading `~` expanded, and through symlinks down to its nearest existing folder, so a new note behind a symlinked folder counts too. A path that can't be resolved asks.
  - **The settings folder reaches the runtime** as `RuntimeRequest.settingsFolder`, set by `AgentManager` from the folders the notes were loaded from, for Channel turns and Workflow runs alike. A legacy data directory has none, so nothing changes there.
  - **The owner sees what's at stake:** a request to edit the settings folder starts with "Change Pero's settings", and a Workflow run's refusal says the settings folder needs the owner's approval.
  - **The owner's own Claude Code allow rules** still apply before Pero is asked, as they always did.

**Done when:**
- Tests show a Claude `ask` Agent edits a note in the vault without a prompt, but is asked before editing `Settings/Agents/Health.md` (including through a symlink or a `../` path) and refused in a Workflow run.
- `bypass` edits freely.

### 8.5 Drop Agent tables

A migration drops `agents` and `settings`. It must keep what `pero migrate` reads from a legacy database (Agents, defaults, the main Agent), as 8.2's `legacy_channel_agents` does for Channel routes, since a newer daemon may migrate a legacy database before its owner runs `pero migrate`. Remove `SettingsService`, the create and edit parts of `AgentsService`, `SqliteDefinitions`' Agent side, and the settings keys the stubs and a legacy data directory's `settings show` still use (`src/cli/settings-keys.ts`). A legacy data directory then has no Agents: it starts degraded and says to run `pero migrate`.

- **Found while building:**
  - **The tables are renamed, not dropped:** `agents` becomes `legacy_agents` and `settings` becomes `legacy_settings`, whole and without entities, beside `legacy_channel_agents`. `pero migrate` reads them with plain SQL (`src/definitions/legacy-definitions.ts`), and all three go with legacy data directories, after 0.2.0. Renaming keeps every row and the main Agent's foreign key, and reverting only renames them back.
  - **A legacy data directory keeps its defaults:** `SqliteDefinitions` serves it with no Agents, and with the time zone, history limits, and run limit `legacy_settings` holds; the data folder is the one `config.yaml` names. Every Channel gets one reply saying to run `pero migrate`, through a new route reason, `legacy`, which replaces `undefined-agent` and `channel-disabled`. Its onboarding records Channels without Agents, and `pero settings show` prints the migrate hint and the bot token.
  - **`settings.update` takes only the bot token,** and `agents.create` and `agents.edit` are gone from the control endpoint. The interactive setup no longer asks for a working folder, which only a legacy data directory needed; `pero run` lists its migration as pending instead.
  - **Readers of the settings row** moved: a schedule without a time zone takes the installation's from `Definitions`, `config.yaml`'s data folder is no longer copied into a row (a missing `config.yaml` still starts from the legacy default working directory), and a backup records the data folder and each Agent's own folder from `Definitions`, not from the snapshot's tables.
  - **`pero migrate` takes the data folder from the legacy `config.yaml`** when it names one, and from `legacy_settings` otherwise, since the row no longer follows edits of the file.
  - **Specs build workspaces:** Agents that tests needed only as fixtures are notes now, written through a shared `TestWorkspace` helper (`src/settings-notes/testing/test-workspace.ts`) that rescans after each write.

**Done when:**
- The schema has no Agent or settings tables.
- No dead code remains for them.
- The full suite and packed-install job pass.

### Phase 8 exit criteria

- Agents, their prompts, defaults, and which topic each answers are configured only by notes, and changes apply within 10 seconds.
- New topics create notes.
- Claude `ask` Agents can't change configuration without asking.
- A migrated installation answers every topic as before.

## Phase 9 — Workflows from notes

### 9.1 Workflows from the snapshot

`FileDefinitions` now serves Workflows too:

- **`channel`** resolves to Channels by title, `chat/topic`, `General`, or ID, through the `channels` table. It gives the notification targets and the default Agent.
- **`history-channels`** resolves the same way.
- **`pero workflows ls`/`show`** show the note path, the schedule as cron, the next run, and the resolved Channels.
- **`pero workflows run`** works for any Workflow, with no manual Trigger needed.
- **Stubs:** `pero workflows create`/`edit`/`enable`/`disable`/`notify` and `pero triggers …`.
- **Found while building:**
  - **The daemon's snapshot resolves references,** as `pero check` through the daemon does: against the Channels Pero has seen in the allowed chats (`src/settings-notes/allowed-channels.ts`). They are looked up again on each scan, and when they change the snapshot is built again (`SettingsReloader.setTopics`), though no note changed. A topic Pero sees for the first time is found within one scan.
  - **A Workflow whose reference doesn't resolve is left out,** like any note with errors. This includes a topic Pero hasn't seen and a chat that is no longer allowed. `status` counts it and `check` lists it. `pero workflows show` and `run` name its note. The last good version only covers errors within the note, so it doesn't apply here; 9.3 reports these errors in Telegram.
  - **Resolved Channels go in the snapshot** (`WorkflowDefinition.resolved`): targets in `channel` order and history Channels, each by ID and each once. `FileDefinitions` serves only Workflows whose references resolved, and no longer reads SQLite.
  - **`enabled: false` stops a Workflow running by itself,** as the [configuration reference](./CONFIGURATION.md#workflow-notes) says. Its schedule gets no runs and its interrupted runs aren't retried, but it still runs and retries by hand. A run its schedule queued fails once the Workflow is disabled. A run started by hand, or a retry, still runs.
  - **A run by hand has no Trigger:** its `trigger_id` is null and its key is `manual:<uuid>`. `src/workflows/run-keys.ts` builds the keys.
  - **A Notification is headed by the note's title,** its file name.
  - **The control endpoint drops** `workflows.create`/`edit`/`notify` and `triggers.*`. `src/cli/workflow-options.ts` and `src/cli/option-names.ts` are removed here rather than in 9.4, since nothing uses them. `TriggersService` and the create and edit parts of `WorkflowsService` stay until 9.4, but nothing at runtime uses them; the runtime helpers of `triggers.service.ts` are gone.
  - **Specs write Workflow notes** (`TestWorkspace.workflow`). A note has one schedule, so the scheduler's specs for several schedules per Workflow define them through a spy.

**Done when:**
- The weekly-report note of the [example workspace](../examples/workspace/) runs by hand, answered by the Health Agent, and posts to Health.
- A title that matches no topic, or several, is an error in `pero check` and `status`.

### 9.2 Schedule reconciliation

On each `snapshotChanged` event and at startup, reconcile `schedules` with the snapshot:

- **A new schedule** gets its next run computed from now.
- **A changed fingerprint** recomputes the next run without catch-up.
- **A removed or disabled Workflow** drops its row and cancels its waiting runs. A running one finishes.

Startup catch-up applies only to notes that still exist and are enabled.

- **Found while building:**
  - **Reconciling runs at three points:** on each change of the definitions (`Definitions.onChange`, so an edit applies right after the scan that reads it), in `ScheduleTick.onModuleInit` (after the executor's startup recovery and before it picks up pending runs), and still at the start of every tick, which catches a change that landed mid-tick. The definitions are read inside the reconciling transaction, so a run queued meanwhile, such as by hand for a new note, is never taken for one of a Workflow that is gone.
  - **Which waiting runs are cancelled:** every pending run of a Workflow that is gone, but only the scheduled ones of a disabled Workflow. A disabled Workflow still runs and retries by hand (9.1), so those runs wait on. They are recorded `cancelled` with `Cancelled before it started: <reason>`, which sends no Notification. The executor still fails a scheduled run of a disabled Workflow it claims, for a change that lands between reconciling and the claim.
  - **A disabled Workflow loses its row,** rather than passing its times as before, so enabling it again starts from now. A schedule whose Agent is disabled or gone still passes its times without a run, since the Workflow itself is unchanged.
  - **A Workflow left out of the snapshot counts as gone:** a note broken since startup, or whose `channel` no longer resolves (9.1), loses its schedule's saved times and waiting runs, and starts afresh once fixed. A note broken after it loaded keeps its last good version, and its schedule.
  - **A renamed note starts a fresh history window** with no change: windows are keyed by the Workflow's name.

**Done when:**
- Editing `hour` moves the next run within one tick.
- Deleting the note cancels a waiting run.
- Renaming a note starts a fresh schedule and history window.
- Times missed while Pero was down still coalesce into one catch-up run.

### 9.3 Configuration errors in Telegram

When a note becomes broken, Pero posts one message per broken version (keyed by content hash), naming the note, property, and reason, and that the last good version stays in use. It goes to the note's related Channels (an Agent's topics, a Workflow's `channel`), or else to the main Agent's primary Channel. The message isn't recorded in Channel history. When the note is fixed, Pero logs it but doesn't post.

- **Found while building:**
  - **`BrokenNoteReports`** (`src/notifications/broken-note-reports.ts`) follows `SettingsNotes.onChange`, and the reloader lists the notes the snapshot reports errors for, with the version read (`SettingsReloader.broken`). A version is keyed by its file and a SHA-256 of its text, kept in memory only.
  - **A broken version is reported once it is used:** a note caught mid-write is never reported, and one with errors of its own is reported after the second scan that reads it, as the log and `status` report it.
  - **Notes broken at startup are only logged:** no edit is waiting for an answer, and posting them would repeat on every restart. Their versions count as known, so a later edit that's still broken posts.
  - **A fixed note is forgotten,** so breaking it again the same way posts again. A note broken by another note's edit is reported too, with its text unchanged: a Workflow whose `agent` note is deleted, or both Agents claiming one topic.
  - **The message** reads `Errors in <note path>:`, then each error as `<property>: <message>`, then what Pero uses meanwhile: `Its last good version stays in use.`, `It's left out until it's fixed.` (such as a Workflow whose `channel` doesn't resolve), or `Pero's own defaults are used until it's fixed.` for `Pero.md`. Nothing follows when the note is in use as it is, such as with a topic two Agents claim.
  - **Related Channels** are those the broken version and the version in use name, among the Channels Pero has seen in the allowed chats: every topic with a title an Agent's `topics` lists, and the Channels a Workflow's `channel` resolves to. **The main Agent's primary Channel** is that of the first chat in `config.yaml` whose primary Channel Pero has seen. Without either, the note is only logged.
  - **One message per Channel** holds every note broken in the same scan, so two Agents claiming one topic post once there.
  - **Sending is best effort,** through `ChannelSender.send`, which records no history: a failed send is logged, not retried, since `status` and `check` still report the note.

**Done when:**
- A typo in a Workflow's `channel` produces exactly one message, a further edit that's still broken produces one more, and fixing it produces none.
- Messages go to the right Channel.

### 9.4 Drop Workflow tables

A migration drops `workflows`, `triggers`, `workflow_notification_targets`, and `allowed_chats`. Remove `TriggersService`, the create and edit parts of `WorkflowsService`, `SqliteDefinitions`, and `src/cli/workflow-options.ts`.

- **Found while building:**
  - **The tables are renamed, not dropped,** as in 8.5: `legacy_workflows`, `legacy_triggers`, `legacy_workflow_notification_targets`, and `legacy_allowed_chats`, whole and without entities. A newer daemon may migrate a legacy database before its owner runs `pero migrate`, which reads its Workflows from them, and startup still moves a row left in `legacy_allowed_chats` into `config.yaml`. `src/definitions/legacy-definitions.ts` reads them with plain SQL, and a spec keeps every other file from naming them. So the schema holds only state, beside the `legacy_` tables that go with legacy data directories after 0.2.0.
  - **Runs stop naming their Trigger:** `workflow_runs.trigger_id` goes, since nothing had set it since 9.1, and with it `triggerId` in `runs.get` and `runs.list`. `workflow_runs` is rebuilt before `triggers` is renamed, so no foreign key follows it.
  - **A legacy data directory has no Workflows either:** `LegacyDataDirDefinitions` replaces `SqliteDefinitions`, with no Agents or Workflows and the defaults `legacy_settings` holds. `DefinitionIds` goes with the IDs it mapped.
  - **`pero migrate`'s schedule split only moves saved times:** a Workflow with several schedules no longer becomes several rows in the copy's tables, which nothing reads; each part's schedule takes the Workflow's saved times, under the part's name.
  - **`WorkflowsService` and `TriggersService` go whole,** with `TriggersModule`, the create, edit, and Trigger input schemas, `slugSchema`, `titleSchema`, and `withoutUndefined`. `src/triggers/schedule.ts` moves to `src/scheduler/schedule.ts`.

**Done when:**
- The schema holds only state (`channels`, `sessions`, `messages`, `workflow_runs`, `notifications`, `schedules`, `inbound_updates`).
- The full suite passes.

### Phase 9 exit criteria

- Workflows, their schedules, prompts, and targets are configured only by notes.
- Schedule edits apply within 10 seconds without spurious catch-up runs.
- Recovery, retries, and notifications behave as before.
- Broken notes are reported in Telegram once.

## Phase 10 — ship

### 10.1 Example workspace and end-to-end test

Add `examples/workspace/` with:

- `config.yaml` (placeholder chat ID)
- `Pero.md`
- `Main.md`, `Health.md`, and `_Template.md`
- the weekly-report and evening-review Workflows

A CI job runs `pero check` on it. An e2e test copies it, writes `.env`, and runs Pero with the echo runtime and fake Telegram adapter. It then checks:

- Health answers the Health topic.
- A new topic writes a note.
- Editing a note changes the answer.
- The weekly report runs on a mocked clock and posts to Health.

- **Found while building:**
  - **The example is a workspace as `pero init` leaves it,** with `.gitignore` listing `.env` and `.pero/.gitignore`, so it can be copied or cloned as it is. The two Workflows are `Weekly health report.md`, as in the [configuration reference](./CONFIGURATION.md#workflow-notes), and `Evening review.md`: at 21:00, the main Agent reads the day's chats and posts what was left open to General. `README.md` says how to start from it.
  - **The CI step runs `pero check --workspace examples/workspace`** after the build in the test job, on every OS and Node version of the matrix. Pero isn't running there, so topic titles are checked for syntax only. The e2e test also runs it on the committed folder and checks that it writes nothing there.
  - **The fake group is the one `config.yaml` allows,** read from the copy, so the test edits nothing but `.env`. It checks the example as committed, and the placeholder chat ID works as it is.
  - **The mocked clock is the scheduler's:** `ScheduleTick.tick` takes the time, and the test passes it the next run time the note gives, a Sunday at 12:00 in `Pero.md`'s time zone. Faking `Date` for the whole daemon would also stop the timers and polling it relies on. Delivery is ticked the same way, instead of waiting for its 5-second interval.
  - **Once General is seen too, `pero check` through the daemon has no problems:** every `channel` in the example resolves. Until then, each Workflow is left out as 9.1 describes. They were broken at startup, so they are only logged, not posted (9.3).

**Done when:** the job and the e2e test pass on the CI matrix.

### 10.2 Docs

Rewrite the [README](../README.md), [User guide](./USER_GUIDE.md), [CLI reference](./CLI.md), [Operations](./OPERATIONS.md), [Architecture](./ARCHITECTURE.md), and [Testing](./TESTING.md) from this proposal. Add an upgrade section: back up, `npm install -g`, `pero migrate ~/workspace`, `pero run`. Move the finished plan into `docs/IMPLEMENTATION_PLAN.md` and delete `docs/vision/`.

- **Found while building:**
  - **[Configuring Pero](./CONFIGURATION.md) is the proposal's configuration reference,** in the present tense and checked against the note schemas, with the user-facing half of its runtime page: how edits apply, broken notes, renamed notes, what Pero writes, and security. [Architecture](./ARCHITECTURE.md) takes the design half in a new "Configuration files" section: the snapshot, `Definitions`, identity, and Pero's writes. Its vocabulary, module table, diagram, and flows follow the code, without the `TriggersModule` 9.4 removed, or a `ToolsModule`: tool policy lives in the runtime adapters.
  - **The proposal's overview** becomes the docs index's decision snapshot and the README's "Agents are notes". Its migration page becomes [Upgrading from 0.1](./OPERATIONS.md#upgrading-from-01); its table of commands was in the CLI reference already. [Tech stack](./TECH_STACK.md) described definitions in SQLite and defaults as creation templates too, and follows the notes now.
  - **The upgrade stops 0.1 before installing 0.2,** since `pero migrate` needs Pero stopped. It names the `--workspace` a service unit needs, and says to move `~/.pero` aside once 0.2 works, since a command run outside any workspace still finds it.
  - **A data folder that is the workspace root** (`data: .`, which `pero migrate ~/workspace` gives when 0.1 worked in `~/workspace`) puts `.env` and `.pero/config.yaml` in the Agents' folder, where a Claude `ask` Agent edits without asking: 8.4's edit policy protects only the settings folder. The docs say so and suggest migrating into a folder of its own, such as `~/pero`, which names `~/workspace` as its data folder. Protecting `.env` and `.pero/` in the edit policy is left for a later change.
  - **Links are checked in CI:** `scripts/check-doc-links.js` resolves every relative link in the committed Markdown files, including `#` anchors, made the way GitHub makes them.
  - **[Testing](./TESTING.md)** lists where the exit criteria of phases 6–9 are verified, and its manual check starts from a workspace and edits a note instead of running `pero agents edit`.
  - **The plan's open questions** became "Questions settled along the way", with the last-good-version question 6.4 settled.

**Done when:** no doc describes SQLite-held definitions or removed commands except as stubs, and every link resolves.

### 10.3 Release 0.2.0

Bump to `0.2.0`, which the release workflow publishes. Before tagging, run `pero migrate` on a real 0.1 installation, as a checklist item in the PR.

**Done when:** a 0.1 installation upgraded by the documented steps answers every topic and runs every Workflow as before.

### After 0.2.0

A later release removes the command stubs, the legacy data directory (`--data-dir`, `PERO_HOME`, `~/.pero`), and the `secrets/` fallback.

## Questions settled along the way

| Question | Settled in | Answer |
|---|---|---|
| Unclaimed topic: new note or main Agent? | 8.3 | A new note (`new-topics: create-agent`) by default; `main-agent` sends it to the main Agent |
| Keep the last good version of a broken note across restarts? | 6.4 | No: it is kept in memory only, since a copy in SQLite could drift from the file |
| Report Codex changes under the settings folder? | 8.4 | No: a documented limitation; give such a Codex Agent a `working-directory` outside the settings folder |
| Accept topic IDs in `topics`? | 8.2 | No: titles only, so a workspace stays portable |
| Several schedules per Workflow note? | 7.4 | No: one note per schedule |

## Cross-cutting decisions to settle during coding

| Decision | Proposed v1 default |
|---|---|
| New Telegram topic | In an allowed chat, onboard a new Agent named after the topic; the General topic and direct chats use the main Agent. Since 8.2–8.3, the Agent is a note whose `topics` claims the topic, and the owner moves a topic by editing `topics`. |
| Unknown Telegram chat | Never reaches a runtime; reply with a rate-limited pairing hint. Chats are allowed only from the host with `pero telegram allow`. |
| Missed schedule intervals | Coalesce to one catch-up run and record how many intervals were skipped. |
| Workflow concurrency | One active run per Workflow; different Agents and Workflows may share a folder concurrently (last write wins). |
| Interrupted execution | Mark `interrupted`; manual retry by default when side effects may have occurred. |
| Notification retry | Bounded attempts with backoff; retain failed records for inspection. |
| Agent execution settings edit | A Session records its provider and effective working directory; a turn resumes it only while the Agent still has both, otherwise it closes that Session and starts a fresh one. A change to the default folder an Agent follows counts. Model and effort edits apply from the next turn of the same Session, like switching models inside the provider CLI. No version counter. |
| Shared instructions | Prepended to each Agent's instructions unless it opts out; edits apply to the next turn of the same Session. Each runtime adapter verifies the SDK accepts updated instructions, model, and effort on a resumed session. |
| Codex in a non-Git folder | Require an explicit Agent setting to skip the SDK Git repository check. |
| Session history | The provider's transcript (reasoning, tool activity, full context) stays in the provider's own storage. Pero stores provider IDs, operational metadata, and each Channel's message history: the text sent and received there. |
| History carry-over | A fresh Session that replaces one in the same Channel starts with the Channel's latest messages (`history-carryover`, default 50, 0 off) within a character budget; resumed Sessions get nothing extra. |
| History retention | Keep everything until the owner sets `history-retention-days`; messages from chats that are not allowed are never stored. |
| Configuration storage | Superseded by phases 5–9: Agents, Workflows, and defaults are notes, host settings are in `config.yaml`, and the token is in `.env`. SQLite keeps only state, such as Channels, Sessions, history, runs, and schedules. |
| Background lifecycle | `pero run` survives terminal exit; automatic startup after reboot is a separate service-manager feature. |

## Highest-value verification

Test the boundaries that could lose or misroute work: CLI start/readiness/stop, singleton process behavior, Telegram topic identity (topics, General, direct chats, and chat migration), onboarding idempotency, Session resume after restart, atomic schedule claim/deduplication, interruption handling, and Notification retries. Use a real temporary SQLite database for persistence tests. Test global installation from a packed npm artifact on supported operating systems, including `better-sqlite3` loading. Provider SDK smoke tests can be gated on credentials; mocks alone cannot prove resume and filesystem behavior.
