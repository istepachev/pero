# Testing Pero

## Test layers

| Command | What it runs | Where |
|---|---|---|
| `npm test` | Unit tests: services against a real temporary SQLite database, adapters against mocked SDKs and a mocked Bot API | CI |
| `npm run test:e2e` | Builds, then starts real daemons in-process on temporary data directories, drives them through the control socket and the CLI, and talks to them through an in-process fake Telegram Bot API over HTTP. Agents use the echo runtime (`PERO_FAKE_RUNTIME=echo`), and fake `claude` and `codex` executables stand in for the sign-in checks. | CI |
| `npm run test:smoke` | Builds, then runs real Claude and Codex turns through the built runtime adapters. Each is skipped unless enabled, uses a little of the subscription, and never runs in CI. | By hand, on the host |
| `bash scripts/check-packed-install.sh` | Installs the `npm pack` artifact into a temporary global prefix and drives `pero` from a fresh home directory: `init`, `run`, what Git commits, a backup with the data folder restored into a `git clone` of the workspace, and a legacy data directory's backup restored into a fresh data directory and into a workspace | CI |

## Provider smoke tests under the service's account

Pero runs Claude and Codex with the sign-ins of the OS account its daemon runs as: Claude Code's under that account's `~/.claude`, and Codex's under its `~/.codex` (or `CODEX_HOME`). A smoke test proves those sign-ins work only when it runs as that same account, with that account's home directory and environment. On the owner's own account, run it as yourself. For a dedicated account, such as `pero`:

1. Put a checkout of the Pero version you run where that account can read it, and install its dependencies as that account:

   ```sh
   sudo -iu pero
   git clone https://github.com/perokit/pero.git ~/pero-src && cd ~/pero-src
   npm ci
   ```

   Use `sudo -iu` (or log in as the account), not `sudo -u` alone: without `-i`, `HOME` and the environment stay the caller's, and the test checks the wrong sign-ins. The login shell needs the same Node.js the service uses on its `PATH`.

2. Check the sign-ins the service will use:

   ```sh
   claude auth status
   npx codex login status
   ```

   Sign in there if either is missing: `claude auth login`, and `npx codex login` (`--device-auth` on a headless host).

3. Run the smoke tests, one provider at a time:

   ```sh
   PERO_SMOKE_CLAUDE=1 npm run test:smoke
   PERO_SMOKE_CODEX=1 npm run test:smoke
   ```

   `PERO_SMOKE_CODEX_MODEL` changes the model the resumed Codex turn switches to (`gpt-5.5` by default).

The Claude test creates a session that writes a file in a temporary folder, resumes it from another process with a different model and effort, checks that resuming a conversation Claude Code does not have is reported as lost (so Pero continues in a fresh Session), checks that an `ask` Agent's shell command is refused, checks that an `ask` Agent writes in its folder but is refused the settings folder, and aborts a turn. The Codex test does the same with a thread, and also checks that a folder outside Git is refused unless the Agent skips the check, that the `ask` sandbox confines writes to the folder, and that a signed-out Codex is reported as such.

When a test fails:
- **Signed out:** sign in again as the service account, not as yourself.
- **Running as root:** Claude Code refuses `bypass` there unless `IS_SANDBOX=1` is set; run the service, and the test, as an ordinary account.
- **Codex `ask` cannot write on Linux:** the sandbox needs unprivileged user namespaces, which Ubuntu 24.04 and later restrict through AppArmor. `npx codex sandbox -- true` shows whether it works; the smoke test skips that check where it cannot.

## Checking a real bot by hand

To see the Telegram path work end to end before any provider is set up, run Pero with the echo runtime, where every Agent answers `echo: <message>`:

1. `PERO_FAKE_RUNTIME=echo pero run`, then follow the [recommended Telegram setup](./USER_GUIDE.md#set-up-telegram) until the group is allowed.
2. Create a topic. Pero posts a welcome naming the new Agent; a message there gets its echo.
3. Create a second topic and write in both; `pero agents` lists an Agent for each, and `pero channels` a Channel for each.
4. Write in the General topic and in a direct chat with the bot. Both answer as the main Agent, and `pero channels` shows them as separate Channels.
5. `pero stop`, then `PERO_FAKE_RUNTIME=echo pero run` again, and write in each Channel: every one answers, and `pero channels show <channel>` says its next turn resumes its Session.
6. `pero agents edit <topic agent> --provider codex`, then write in that topic: the echo starts with `[Earlier conversation in this chat`, the Channel's recent messages.
7. Stop Pero and start it without `PERO_FAKE_RUNTIME` to use the real providers.

## Phase 2 exit criteria

Where each [Phase 2 exit criterion](./IMPLEMENTATION_PLAN.md#phase-2-exit-criteria) is verified. `test/phase2.e2e-spec.ts` walks through them in one story with the fake Bot API and the echo runtime.

| Criterion | Verified by |
|---|---|
| Creating a topic in an allowed forum group onboards a new Agent that answers there | `test/phase2.e2e-spec.ts`; onboarding edge cases in `src/channels/channel-onboarding.spec.ts` |
| Two topics keep separate contexts while working in the same shared folder | `test/phase2.e2e-spec.ts`: separate Agents, Sessions, and provider sessions, both in the default folder |
| An Agent with its own folder works there | `test/phase2.e2e-spec.ts`; `test/agents.e2e-spec.ts` |
| The General topic and a direct chat reach the main Agent in separate Sessions | `test/phase2.e2e-spec.ts` |
| A follow-up resumes the right provider session after a restart | `test/phase2.e2e-spec.ts`: each of four Channels resumes its own provider session in a new daemon; real resume from another process in both smoke tests |
| A new provider or folder starts a fresh Session that carries over recent messages; a new model or effort continues it | `test/phase2.e2e-spec.ts`; `test/agents.e2e-spec.ts`; `test/channels.e2e-spec.ts` for reassignment |
| Each Channel's history holds the text sent and received there, and nothing else | `test/phase2.e2e-spec.ts`; `test/channels.e2e-spec.ts`; `src/agents/agent-manager.spec.ts` |
| A chat that is not allowed invokes no runtime, creates no Agent, and gets only the pairing hint | `test/phase2.e2e-spec.ts`; `test/telegram.e2e-spec.ts`; `src/channels/channel-router.spec.ts` |
| Codex and Claude subscription sign-ins each have a documented SDK smoke test under the service's account | `test/smoke/claude-runtime.smoke-spec.ts` and `test/smoke/codex-runtime.smoke-spec.ts`, run as in [the section above](#provider-smoke-tests-under-the-services-account) |

## Phase 3 exit criteria

Where each [Phase 3 exit criterion](./IMPLEMENTATION_PLAN.md#phase-3-exit-criteria) is verified.

| Criterion | Verified by |
|---|---|
| A missed scheduled run is found after restart | `test/workflows.e2e-spec.ts`: one catch-up run for the times a schedule missed while Pero was down; `src/scheduler/schedule-tick.spec.ts`: missed times |
| Duplicate polls create one run per trigger occurrence | `src/scheduler/schedule-tick.spec.ts`: one run per time however often it polls, and when polls overlap |
| An interrupted run is visibly recorded and handled according to its policy | `test/workflows.e2e-spec.ts`: a run Pero stopped is recorded interrupted and retried as its Workflow allows; `src/workflows/workflow-runs.spec.ts` |
| A scheduled Workflow reads each message in its Channel history window exactly once across runs | `src/workflows/workflow-runs.spec.ts`: adjacent windows across consecutive runs, and a retry reading the window of the run it retries; `test/restore.e2e-spec.ts` across a restore |

## Phase 4 exit criteria

Where each [Phase 4 exit criterion](./IMPLEMENTATION_PLAN.md#phase-4-exit-criteria) is verified.

| Criterion | Verified by |
|---|---|
| A Workflow can notify a configured topic | `test/workflows.e2e-spec.ts`: notifies the Channels a Workflow names; `src/notifications/run-notifications.spec.ts` |
| A daily Workflow can review the previous day's chats and deliver suggestions to a chosen topic, where the owner can reply to them | `test/restore.e2e-spec.ts`: a Workflow reading every Channel's history notifies a topic, and the next message there receives its suggestion; `test/workflows.e2e-spec.ts`: the next turn receives a delivered Notification; schedules as in Phase 3 |
| A temporary Telegram delivery failure remains visible and retries without creating duplicate Workflow Runs | `test/workflows.e2e-spec.ts`: delivers a Notification once Telegram is back; `src/notifications/notification-delivery.spec.ts`: retries after backoff without another run |
| Restore brings back definitions and resumable Sessions | `test/restore.e2e-spec.ts`, which follows the drill in [Operating Pero](./OPERATIONS.md#moving-to-a-fresh-machine): every definition comes back and every Channel resumes its provider session, and a Channel whose provider conversation is gone continues in a fresh Session with its history; `test/cli.e2e-spec.ts` and `scripts/check-packed-install.sh` for `pero backup` and `pero restore` themselves |

## Phase 5 exit criteria

Where each [Phase 5 exit criterion](./vision/IMPLEMENTATION_PLAN.md#phase-5-exit-criteria) is verified.

| Criterion | Verified by |
|---|---|
| `pero init ~/workspace && cd ~/workspace && pero run` sets up a working Pero with its state in `.pero/` and its token in `.env` | `test/cli.e2e-spec.ts`: `init` and a run from home, and the token of a workspace in its `.env`; `test/daemon.e2e-spec.ts`: the state in `.pero/`; `scripts/check-packed-install.sh` |
| Committing the workspace commits `config.yaml` and nothing secret | `scripts/check-packed-install.sh`: `git add -A` in a running workspace stages `config.yaml` and the notes, not `.env`, the database, logs, or `run/`; `test/cli.e2e-spec.ts` and `src/config/env-file.spec.ts`: `pero status` reports a `.env` Git would commit |
| Allowed chats can be changed by editing `config.yaml` | `src/host-config/host-config.service.spec.ts`: chats added or removed by hand are served or turned away from the next look, and a broken edit keeps the last valid version; `test/cli.e2e-spec.ts`: `telegram allow` and `deny` edit the file while Pero is stopped, and an invalid file stops startup |
| Backups restore into a cloned workspace | `test/restore.e2e-spec.ts`: a workspace restored into a fresh clone at its path, with its data folder, resumes every Session; `test/cli.e2e-spec.ts`: a clone keeps its `config.yaml` and data files; `src/cli/restore.spec.ts`; `scripts/check-packed-install.sh`: a `git clone` |
| A legacy data directory still works unchanged | `test/restore.e2e-spec.ts` and `test/cli.e2e-spec.ts` with `--data-dir`; `test/cli.e2e-spec.ts` and `scripts/check-packed-install.sh`: a legacy backup restored into a workspace, its token in `.env` |
