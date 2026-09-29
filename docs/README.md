# Pero implementation docs

These documents turn the agreed design for Pero into a starting point for implementation.

1. [Architecture](./ARCHITECTURE.md) — domain vocabulary, module boundaries, data model, request and workflow flows, recovery, and scaling path.
2. [Tech stack](./TECH_STACK.md) — chosen technologies, deployment shape, configuration, and operational rules.
3. [CLI and service lifecycle](./CLI.md) — installation, first run, commands, background process, and local files.
4. [Implementation plan](./IMPLEMENTATION_PLAN.md) — build order, split into pull requests, with acceptance criteria for an initial release.
5. [Testing](./TESTING.md) — test layers, provider smoke tests under the service's account, a manual check with a real bot, and where each phase's exit criteria are verified.
6. [Operating Pero](./OPERATIONS.md) — install and upgrade, credentials, data layout, message history, backup, and restoring on a fresh machine.

## Decision snapshot

Pero is a self-hosted, single-user **TypeScript/NestJS 12 modular monolith** installed as a native service. A Channel is a transport-independent conversation endpoint: **Telegram is the first Channel integration**: the recommended setup is a private group with topics enabled and the bot as an administrator, where each topic maps to a separate Channel and creating a topic onboards a new Agent; the General topic and a direct chat with the bot are Channels without a topic ID, assigned the main Agent. Only allowlisted chats reach Agents. Slack, Discord, and other integrations can be added later through the same Channel boundary. Each Channel is assigned to an Agent. Every Agent stores its provider (Claude or Codex), provider options (model and effort), and working directory. Installation defaults prefill new Agents; all Agents share one working directory (such as a notes vault) chosen during setup unless one is explicitly given its own, and share optional instructions such as a common personality. Claude Agent SDK and Codex SDK are accessed through separate Agent Runtime adapters. Interactive Sessions are distinct from background Workflow Runs. Pero keeps each Channel's message history (the text sent and received, not the provider's reasoning or tool activity), so a fresh Session on another provider can continue the conversation and Workflows can review past chats. User-defined Triggers start Workflows; Workflows may create Notifications addressed to Channels. TypeORM stores durable state in SQLite through `better-sqlite3` with WAL enabled. A small in-process scheduler and bounded executor do the active work; SQLite records what must survive a restart. PostgreSQL, Redis, and additional processes are future options rather than installation requirements.

Authentication is **subscription-only** for both Agent Runtimes. The owner signs in through the installed Claude Code and Codex CLIs under the same OS account that runs the service. See [Tech stack §7](./TECH_STACK.md#7-native-installation-and-subscription-authentication).

Agent, Workflow, and Trigger definitions remain authoritative in SQLite. The `pero` CLI is the owner-facing way to inspect and change them; JSON export/import may be added for file-based review. The target install and control flow is:

```sh
npm install -g @perokit/pero
pero run
pero agents ls
pero stop
```

The package is published as `@perokit/pero` from the [perokit/pero](https://github.com/perokit/pero) repository; its executable is `pero`. `pero run` starts a background process and guides first-time setup when needed. See the [CLI contract](./CLI.md) for readiness, status, logs, and shutdown behavior.

The detailed choices below are an implementation proposal based on the prior design discussion. Fields, indexes, and recovery policies are explicit so they can be reviewed before coding.
