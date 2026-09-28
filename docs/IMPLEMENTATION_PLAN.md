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

### 3.6 Channel history as Workflow input

A Workflow can read Channel history, so an Agent can review conversations on a schedule. For example, an `english-coach` Agent can read the day's chats every evening and suggest improvements.

Add optional history input to Workflows as `history_json`, validated with Zod. It chooses:
- **Channels:** all of them, or a list.
- **Messages:** only the ones people wrote, or both directions.
- **Window:** since the previous successful run (the default; a first run reads the last 24 hours), or a fixed number of hours.

How a run reads its window:
- **Fixed on claim:** when the executor claims a run, it fixes the end of the window and records the window in the run's snapshot. Mark the window's end by message ID: `created_at` has whole seconds, so a time alone can split or repeat messages at the boundary.
- **Retries and later runs:** a retry reads the same messages, and the next run starts where this one ended, with no gaps and no overlaps.
- **Rendering:** the messages become a transcript: local time, Channel title, who spoke, and text. It goes into the input template's `{{history}}` placeholder, or after the input when there is none.
- **Size limit:** a character budget drops the oldest messages first, and the transcript notes that it did.
- **Empty windows:** a run whose window has no messages completes without invoking the Agent and records that it was skipped. A Workflow can opt out of this and run anyway.
- **CLI:** `pero workflows create|edit` set and clear the history input.

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

Add `pero workflows notify <workflow> <channel>` (and removal). When a run finishes, create its Notification records in the same transaction as the final run status.

**Done when:** tests show a completed run and its Notifications commit together, and a Notification failure never keeps a run `running`.

### 4.2 Delivery worker

Dispatch pending Notifications through the Channel adapter with bounded attempts and backoff, recording `provider_message_id`, attempts, and last error. Failed records stay visible. Record each delivered Notification in its Channel's history with origin `workflow`, linked to the Notification. The next interactive turn in that Channel places the Notifications delivered since its Session's previous turn before the input, so the owner can reply to one, such as by asking about a suggestion in the English topic.

**Done when:** a simulated Telegram outage leaves the Notification retrying and delivers it once Telegram recovers, without creating another Workflow Run; a delivered Notification appears in the Channel's history once, and the next turn there receives its text.

### 4.3 Operations commands

Add `pero runs ls|show|retry|cancel` and `pero notifications ls|show|retry` with delivery diagnostics. Add the `history-retention-days` setting: unset keeps all history, otherwise a daily task deletes older messages.

**Done when:** e2e tests cover inspection and manual retry of both runs and Notifications, and history older than the retention setting is deleted.

### 4.4 Operations documentation and restore drill

Document install, provider and Telegram credentials, data layout, message history (what is stored, retention, and that backups contain it), backup, and restore. Extend the 1.11 restore test to cover definitions and resumable Sessions, and document backing up the working folders.

**Done when:** a documented backup/restore on a fresh machine brings back definitions and resumable Sessions, with working folders restored from the owner's own backup.

### Phase 4 exit criteria

A Workflow can notify a configured topic; a daily Workflow can review the previous day's chats and deliver suggestions to a chosen topic, where the owner can reply to them; a temporary Telegram delivery failure remains visible and retries without creating duplicate Workflow Runs; restore brings back definitions and resumable sessions.

## Cross-cutting decisions to settle during coding

| Decision | Proposed v1 default |
|---|---|
| New Telegram topic | In an allowed chat, onboard a new Agent named after the topic; the General topic and direct chats use the main Agent. The owner can reassign with `pero channels assign`. |
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
| Configuration storage | SQLite is authoritative for Agents, Channels, Workflows, and Triggers; CLI operations validate changes. JSON export/import may be added without live file synchronization. |
| Background lifecycle | `pero run` survives terminal exit; automatic startup after reboot is a separate service-manager feature. |

## Highest-value verification

Test the boundaries that could lose or misroute work: CLI start/readiness/stop, singleton process behavior, Telegram topic identity (topics, General, direct chats, and chat migration), onboarding idempotency, Session resume after restart, atomic schedule claim/deduplication, interruption handling, and Notification retries. Use a real temporary SQLite database for persistence tests. Test global installation from a packed npm artifact on supported operating systems, including `better-sqlite3` loading. Provider SDK smoke tests can be gated on credentials; mocks alone cannot prove resume and filesystem behavior.
