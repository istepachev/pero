# Pero implementation plan

This sequence produces a working personal installation in small, reviewable increments. The acceptance criteria describe behavior rather than a particular internal class layout.

## Phase 1 — boot and persistence

Create the NestJS 12 application, Fastify health endpoint, validated configuration, Pino logging, TypeORM data source, and explicit migrations. Build the CLI with nest-commander. Package compiled CLI and daemon entry points in the public `@perokit/pero` npm package whose `bin` exposes `pero`. Implement `pero run`, `pero run --foreground`, `pero stop`, `pero status`, and `pero logs`, with one background process per data directory, a private local control endpoint, readiness handshake, and graceful shutdown. Default to `~/.pero`, with a data-directory override. The daemon exclusively owns SQLite; the CLI is a control-endpoint client that never opens the database. The daemon reports ready once the database is migrated, marking missing or invalid Telegram and provider settings as degraded instead of failing. First interactive run creates local storage and guides missing setup through the daemon; non-interactive run reports actionable missing settings. Seed SQLite settings for default provider, model per provider, and workspace root. Add the first entities: Agent (including provider, model choice, and working directory), Channel, Session, Workflow, Trigger, WorkflowRun, Notification, and inbound update key. Keep definitions authoritative in SQLite.

**Done when:** installation from a packed npm artifact exposes `pero`; `pero run` starts a background process and waits for readiness; a second `run` does not create a duplicate; `pero status` reports the process and any degraded components; management commands fail with a clear message when the daemon is stopped; a daemon with missing Telegram setup still starts and can be configured; `pero stop` shuts it down and is safe to repeat. A fresh install initializes its database and defaults; creating an Agent copies defaults into its record and creates a dedicated working folder; changing defaults leaves existing Agents unchanged; a restart keeps records; migrations run cleanly; a backup restores to a fresh data directory.

## Phase 2 — interactive path

Implement the generic Channel router and Channel adapter contract, then add Telegram through grammY as the first integration. Register each Telegram topic as a Channel and assign it an Agent. Keep the Channel contract able to accept future Slack, Discord, and other adapters. Implement `AgentManager`, the agent execution runtime contract, and one provider adapter first; add the second through the same contract. Pass each Agent's saved model and working directory explicitly to its provider adapter. Add `pero agents ls` and initial Agent management commands using the same validated application services as the daemon. Persist provider session IDs and serialize turns per Channel/Session and working directory. Add allowlists and inbound deduplication.

**Done when:** two Telegram topics assigned to different Agents retain separate contexts and work in their own folders; a follow-up resumes the right provider session after a process restart; editing provider, model, or folder starts a fresh Session; unauthorized messages do not invoke a runtime. Codex and Claude subscription sign-ins each have a documented SDK smoke test under the OS account running the service.

## Phase 3 — durable workflows

Add manual Triggers, Workflow Runs, and the bounded executor. Add schedule Triggers with timezone-aware `next_run_at` calculation and a polling tick. Create pending runs and advance schedules transactionally. Define missed-run coalescing, retry policy, cancellation, and startup recovery.

**Done when:** a missed scheduled run is found after restart; duplicate polls create one run per trigger occurrence; an interrupted run is visibly recorded and handled according to its policy.

## Phase 4 — notifications and operations

Add Workflow notification targets, durable Notification records, Telegram delivery, retry state, and delivery diagnostics. Expose run inspection, manual retry/cancel, and Workflow/Trigger management through owner-only CLI commands. Document install, credentials, storage, backup, and restore.

**Done when:** a Workflow can notify a configured topic; a temporary Telegram delivery failure remains visible and retries without creating duplicate Workflow Runs; restore brings back definitions, workspaces, and resumable sessions.

## Cross-cutting decisions to settle during coding

| Decision | Proposed v1 default |
|---|---|
| Unknown Telegram topic | Reject with an owner-facing setup hint; explicit Channel enrollment. |
| Missed schedule intervals | Coalesce to one catch-up run and record how many intervals were skipped. |
| Workflow concurrency | One active run per Workflow and one per workspace unless explicitly overridden. |
| Interrupted execution | Mark `interrupted`; manual retry by default when side effects may have occurred. |
| Notification retry | Bounded attempts with backoff; retain failed records for inspection. |
| Agent execution settings edit | Close active interactive Sessions when provider, model choice, or working directory changes; start a new provider context on the next turn. |
| Codex in a non-Git folder | Require an explicit Agent setting to skip the SDK Git repository check. |
| Session history | Provider transcript is for provider context; the runtime database stores IDs and operational metadata. |
| Configuration storage | SQLite is authoritative for Agents, Channels, Workflows, and Triggers; CLI operations validate changes. JSON export/import may be added without live file synchronization. |
| Background lifecycle | `pero run` survives terminal exit; automatic startup after reboot is a separate service-manager feature. |

## Highest-value verification

Test the boundaries that could lose or misroute work: CLI start/readiness/stop, singleton process behavior, Telegram topic identity, Session resume after restart, atomic schedule claim/deduplication, interruption handling, and Notification retries. Use a real temporary SQLite database for persistence tests. Test global installation from a packed npm artifact on supported operating systems, including `better-sqlite3` loading. Provider SDK smoke tests can be gated on credentials; mocks alone cannot prove resume and filesystem behavior.
