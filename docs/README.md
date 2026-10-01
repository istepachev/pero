# Pero docs

For people using Pero:

- [User guide](./USER_GUIDE.md) — first-run setup, Telegram, Agents and permissions, and Workflows.
- [Configuring Pero](./CONFIGURATION.md) — the workspace, `.env`, `config.yaml`, and every property of `Pero.md`, Agent notes, and Workflow notes; how edits apply, and what Pero writes.
- [Operating Pero](./OPERATIONS.md) — install and upgrade, credentials, data layout, message history, backup, and restoring on a fresh machine.
- [CLI reference](./CLI.md) — every command and what it does.

For people working on Pero:

- [Development](./DEVELOPMENT.md) — building, running from a checkout, tests, daemon internals, and releasing.

## Design docs

1. [Architecture](./ARCHITECTURE.md) — domain vocabulary, module boundaries, configuration loading, data model, request and workflow flows, recovery, and scaling path.
2. [Tech stack](./TECH_STACK.md) — chosen technologies, deployment shape, configuration, and operational rules.
3. [CLI and service lifecycle](./CLI.md) — installation, first run, commands, background process, and local files.
4. [Roadmap](./ROADMAP.md) — the next release, open items, and what was decided against.
5. [Testing](./TESTING.md) — test layers, provider smoke tests under the service's account, a manual check with a real bot, and which tests verify each behavior.
6. [Operating Pero](./OPERATIONS.md) — install and upgrade, credentials, data layout, message history, backup, and restoring on a fresh machine.

## Decision snapshot

Pero is a self-hosted, single-user **TypeScript/NestJS 12 modular monolith** installed as a native service. It runs in a **workspace**: a folder, which can be a Git repository, holding the data folder the Agents work in (such as an Obsidian vault) and Pero's own `.pero/` folder.

**Configuration is files.** Agents, Workflows, and the installation defaults are Markdown notes in the data folder's `Settings/`: the note body is the prompt, and its properties are the settings. `.pero/config.yaml` says where the data folder is and which chats Pero serves, and the Telegram bot token is in the workspace's `.env`, never committed. Pero rescans the notes every 10 seconds, so an edit from Obsidian, Syncthing, `git pull`, or an Agent applies without a restart, and a broken note is reported without taking Pero down. **SQLite keeps state, not configuration:** Channels, Sessions, message history, Workflow Runs, schedules, and Notifications, through TypeORM and `better-sqlite3` with WAL enabled. State names an Agent or Workflow by its note's name.

A Channel is a transport-independent conversation endpoint. **Telegram is the first Channel integration:** the recommended setup is a private group with topics enabled and the bot as an administrator, where each topic is a separate Channel, answered by the Agent whose note claims the topic's title in `topics`; a new topic no note claims gets a note of its own. The General topic and a direct chat with the bot are Channels without a topic ID, answered by the main Agent. Only allowed chats reach Agents. Slack, Discord, and other integrations can be added later through the same Channel boundary.

Every Agent has a provider (Claude or Codex), provider options (model and effort), and a working directory: the data folder unless its note names another. `Pero.md`'s defaults apply live to every Agent that doesn't set its own, and its body is shared instructions placed before each Agent's own. Claude Agent SDK and Codex SDK are accessed through separate Agent Runtime adapters. Interactive Sessions are distinct from background Workflow Runs. Pero keeps each Channel's message history (the text sent and received, not the provider's reasoning or tool activity), so a fresh Session on another provider can continue the conversation and Workflows can review past chats. A Workflow's note sets its schedule, and each run may notify the topics it names. A small in-process scheduler and bounded executor do the active work; SQLite records what must survive a restart. PostgreSQL, Redis, and additional processes are future options rather than installation requirements.

Authentication is **subscription-only** for both Agent Runtimes. The owner signs in through the installed Claude Code and Codex CLIs under the same OS account that runs the service. See [Tech stack §7](./TECH_STACK.md#7-native-installation-and-subscription-authentication).

The `pero` CLI starts, stops, inspects, checks, and backs up; it doesn't create or edit definitions, which are files. The install and control flow is:

```sh
npm install -g @perokit/pero
pero init ~/workspace
cd ~/workspace && pero run
pero check
pero agents
pero stop
```

The package is published as `@perokit/pero` from the [perokit/pero](https://github.com/perokit/pero) repository; its executable is `pero`. `pero run` starts a background process and guides first-time setup when needed. See the [CLI contract](./CLI.md) for readiness, status, logs, and shutdown behavior.
