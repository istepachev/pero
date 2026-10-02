# Pero docs

For people using Pero:

- [User guide](./USER_GUIDE.md) — first-run setup, Telegram, personality, instructions, Channel notes and permissions, and Workflows.
- [Configuring Pero](./CONFIGURATION.md) — the workspace, `.env`, `config.yaml`, and every property of `Pero.md`, `Persona.md` and `Instructions.md`, Channel notes, and Workflow notes; how edits apply, and what Pero writes.
- [Operating Pero](./OPERATIONS.md) — install and upgrade, credentials, data layout, message history, backup, and restoring on a fresh machine.
- [CLI reference](./CLI.md) — every command and what it does.

For people working on Pero:

- [Development](./DEVELOPMENT.md) — building, running from a checkout, tests, daemon internals, and releasing.

## Design docs

- [Architecture](./ARCHITECTURE.md) — domain vocabulary, module boundaries, configuration loading, data model, request and workflow flows, recovery, and scaling path.
- [Tech stack](./TECH_STACK.md) — chosen technologies, deployment shape, configuration, and operational rules.
- [CLI and service lifecycle](./CLI.md) — the command contract, first run, background process, and local files.
- [Testing](./TESTING.md) — test layers, provider smoke tests under the service's account, a manual check with a real bot, and which tests verify each behavior.
- [Roadmap](./ROADMAP.md) — open items, and what was decided against.

## Decision snapshot

Pero is a self-hosted, single-user **TypeScript/NestJS 12 modular monolith** installed as a native service. It runs in a **workspace**: a folder, which can be a Git repository, that Pero works in, holding the data folder where it keeps notes (such as an Obsidian vault) and Pero's own `.pero/` folder.

**Configuration is files.** Pero's personality (`Persona.md`) and instructions (`Instructions.md`), a note per Channel, Workflows, and the installation defaults are Markdown notes in the data folder's `System/`: the note body is the prompt, and its properties are the settings. `.pero/config.yaml` says where the data folder is and which chats Pero serves, and the Telegram bot token is in the workspace's `.env`, never committed. Pero rescans the notes every 10 seconds, so an edit from Obsidian, Syncthing, `git pull`, or Pero itself applies without a restart, and a broken note is reported without taking Pero down. **SQLite keeps state, not configuration:** Channels, Sessions, message history, Workflow Runs, schedules, and Notifications, through TypeORM and `better-sqlite3` with WAL enabled. State names a Workflow by its note's name, and keeps a Session per Channel.

A Channel is a transport-independent conversation endpoint. **Telegram is the first Channel integration:** the recommended setup is a private group with topics enabled and the bot as an administrator, where each topic is a separate Channel with its own note in `Channels/`, bound to it by `channel-id`; a new topic gets a note of its own. The General topic and a direct chat with the bot are Channels without a topic ID, answered with `Channels/Default.md`. Only allowed chats reach Pero. Slack, Discord, and other integrations can be added later through the same Channel boundary.

Every turn's instructions are `Persona.md`, then `Instructions.md`, then the Channel note's own text, after a context that names the data folder as where notes go. A Channel note sets a provider (Claude or Codex), provider options (model and effort), permissions, and a working directory: the workspace unless it names another. `Pero.md`'s defaults apply live to every Channel whose note doesn't set its own. Claude Agent SDK and Codex SDK are accessed through separate Agent Runtime adapters. Interactive Sessions are distinct from background Workflow Runs. Pero keeps each Channel's message history (the text sent and received, not the provider's reasoning or tool activity), so a fresh Session on another provider can continue the conversation and Workflows can review past chats. A Workflow's note sets its schedule, and each run uses the note of the first Channel it names and may notify the Channels it names. A small in-process scheduler and bounded executor do the active work; SQLite records what must survive a restart. PostgreSQL, Redis, and additional processes are future options rather than installation requirements.

Authentication is **subscription-only** for both Agent Runtimes, the provider adapters. The owner signs in through the installed Claude Code and Codex CLIs under the same OS account that runs the service. See [Tech stack §7](./TECH_STACK.md#7-native-installation-and-subscription-authentication).

The `pero` CLI starts, stops, inspects, checks, and backs up; it doesn't create or edit definitions, which are files. The install and control flow is:

```sh
npm install -g @perokit/pero
mkdir ~/workspace && cd ~/workspace
pero run
pero check
pero channels
pero stop
```

The package is published as `@perokit/pero` from the [perokit/pero](https://github.com/perokit/pero) repository; its executable is `pero`. `pero run` starts a background process and guides first-time setup when needed. See the [CLI contract](./CLI.md) for readiness, status, logs, and shutdown behavior.
