# Pero implementation docs

These documents turn the agreed design for Pero into a starting point for implementation.

1. [Architecture](./ARCHITECTURE.md) — domain vocabulary, module boundaries, data model, request and workflow flows, recovery, and scaling path.
2. [Tech stack](./TECH_STACK.md) — chosen technologies, deployment shape, configuration, and operational rules.
3. [CLI and service lifecycle](./CLI.md) — installation, first run, commands, background process, and local files.
4. [Implementation plan](./IMPLEMENTATION_PLAN.md) — build order and acceptance criteria for an initial release.

## Decision snapshot

Pero is a self-hosted, single-user **TypeScript/NestJS modular monolith** installed as a native service. A Channel is a transport-independent conversation endpoint: **Telegram is the first Channel integration**, and each Telegram topic maps to a separate Channel. Slack, Discord, and other integrations can be added later through the same Channel boundary. Each Channel is assigned to an Agent. Every Agent stores its provider (Claude or Codex), model choice, and working directory. Installation defaults prefill new Agents, with a dedicated folder for each Agent by default. Claude Agent SDK and Codex SDK are accessed through separate Agent Runtime adapters. Interactive Sessions are distinct from background Workflow Runs. User-defined Triggers start Workflows; Workflows may create Notifications addressed to Channels. TypeORM stores durable state in SQLite through `better-sqlite3` with WAL enabled. A small in-process scheduler and bounded executor do the active work; SQLite records what must survive a restart. PostgreSQL, Redis, and additional processes are future options rather than installation requirements.

Authentication is **subscription-only** for both Agent Runtimes. The owner signs in through the installed Claude Code and Codex CLIs under the same OS account that runs the service. See [Tech stack §7](./TECH_STACK.md#7-native-installation-and-subscription-authentication).

Agent, Workflow, and Trigger definitions remain authoritative in SQLite. The `pero` CLI is the owner-facing way to inspect and change them; JSON export/import may be added for file-based review. The target install and control flow is:

```sh
npm install -g @your-scope/pero
pero run
pero agents ls
pero stop
```

Replace `your-scope` with the publisher's npm username or organization scope. The package name is scoped because the unscoped `pero` name is taken; its executable is still `pero`. `pero run` starts a background process and guides first-time setup when needed. See the [CLI contract](./CLI.md) for readiness, status, logs, and shutdown behavior.

The detailed choices below are an implementation proposal based on the prior design discussion. Fields, indexes, and recovery policies are explicit so they can be reviewed before coding.
