# Testing Pero

## Test layers

| Command | What it runs | Where |
|---|---|---|
| `npm test` | Unit tests: services against a real temporary SQLite database, adapters against mocked SDKs and a mocked Bot API | CI |
| `npm run test:e2e` | Builds, then starts real daemons in-process on temporary workspaces, drives them through the control socket and the CLI, and talks to them through an in-process fake Telegram Bot API over HTTP. Agents use the echo runtime (`PERO_FAKE_RUNTIME=echo`), and fake `claude` and `codex` executables stand in for the sign-in checks. | CI |
| `npm run test:smoke` | Builds, then runs real Claude and Codex turns through the built runtime adapters. Each is skipped unless enabled, uses a little of the subscription, and never runs in CI. | By hand, on the host |
| `node scripts/check-doc-links.js` | Checks that every relative link in the committed Markdown files resolves, headings included | CI |
| `node bin/pero.js check --workspace examples/workspace` | Checks the [example workspace](../examples/workspace/) as committed, after the build | CI |
| `bash scripts/check-packed-install.sh` | Installs the `npm pack` artifact into a temporary global prefix and drives `pero` from a fresh home directory: `run` without a workspace, `init`, `run`, what Git commits, and a backup with the data folder restored into a `git clone` of the workspace | CI |

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

1. `pero init ~/pero-check && cd ~/pero-check`, then `PERO_FAKE_RUNTIME=echo pero run`, and follow the [recommended Telegram setup](./USER_GUIDE.md#set-up-telegram) until the group is allowed.
2. Create a topic. Pero writes its note, `data/Settings/Agents/<Topic title>.md`, and posts a welcome naming the new Agent; a message there gets its echo.
3. Create a second topic and write in both; `pero agents` lists an Agent and a note for each, and `pero channels` a Channel for each.
4. Write in the General topic and in a direct chat with the bot. Both answer as the main Agent, and `pero channels` shows them as separate Channels.
5. `pero stop`, then `PERO_FAKE_RUNTIME=echo pero run` again, and write in each Channel: every one answers, and `pero channels show <channel>` says its next turn resumes its Session.
6. Add `provider: codex` to the properties of one topic's note, wait 10 seconds, then write in that topic: the echo starts with `[Earlier conversation in this chat`, the Channel's recent messages.
7. Break that note, such as with `provider: codx`: within about 20 seconds, the topic gets one message naming the error, and its Agent keeps answering with the last good version. `pero check` lists the error.
8. Stop Pero and start it without `PERO_FAKE_RUNTIME` to use the real providers.

## Checking a release on a fresh machine

Before merging a PR that bumps the version, walk through the README's [Get started](../README.md#get-started) as a new owner would: on a fresh VPS, with a real bot and a real provider, and with the package that PR publishes. Copy the steps into the PR as a checklist.

1. **Install the package from the PR's branch**, under an ordinary account with a supported Node.js:

   ```sh
   git clone --branch <branch> https://github.com/perokit/pero.git ~/pero-src && cd ~/pero-src
   npm ci && npm pack
   npm install -g ./perokit-pero-<version>.tgz && cd
   pero --version   # the new version
   ```

2. **`mkdir ~/workspace && cd ~/workspace && pero run`.** It offers to make the folder a workspace, then asks for the bot token and a provider sign-in, and `pero status` then shows Telegram and the provider ready.
3. **Allow a group.** Create a private group with Topics turned on, add the bot as an administrator, and write in it: `pero run` offers to allow that chat.
4. **Onboard a topic.** Create one: Pero writes `data/Settings/Agents/<Topic title>.md` and posts a welcome naming the new Agent. A message there gets the provider's answer, and a second one continues the conversation.
5. **Edit a note.** Change that note's instructions, wait 10 seconds, and write in the topic: the answer follows the edit. Break the note, such as with `provider: codx`: the topic gets one message naming the error, and `pero check` lists it. Fix it again.
6. **Run a Workflow.** Copy [Evening review](../examples/workspace/data/Settings/Workflows/Evening%20review.md) into `data/Settings/Workflows/`, with `channel` set to the topic's title. `pero workflows` shows its next run, and `pero workflows run evening-review` prints the answer and posts it in the topic.
7. **Back up.** Commit the workspace to Git (`git init && git add -A && git commit -m Workspace`): `git show --stat HEAD` lists `.pero/config.yaml` and the notes, but not `.env`, the database, `logs/`, or `run/`. Then `mkdir -p ~/backups && pero backup ~/backups/pero.tgz`.
8. **Restore into a clone** at the same path, as [Moving to a fresh machine](./OPERATIONS.md#moving-to-a-fresh-machine) does:

   ```sh
   pero stop
   mv ~/workspace ~/workspace-old && git clone ~/workspace-old ~/workspace && cd ~/workspace
   pero restore ~/backups/pero.tgz
   pero telegram token   # paste the bot token again
   pero run
   ```

   `pero channels show <channel>` says the topic's next turn resumes its Session, and a message there continues the conversation.

## Where each behavior is verified

The tests that matter most guard the boundaries that could lose or misroute work. `test/interactive.e2e-spec.ts` walks through the interactive path in one story with the fake Bot API and the echo runtime.

### The daemon and the CLI

| Behavior | Verified by |
|---|---|
| `pero run` in a new folder, or `pero init ~/workspace` then `pero run`, sets up a working Pero with its state in `.pero/` and its token in `.env` | `src/cli/setup/first-run.spec.ts`: the offer to make a workspace; `test/cli.e2e-spec.ts`: `init` and a run from home, and the token in `.env`; `test/daemon.e2e-spec.ts`: the state in `.pero/`; `scripts/check-packed-install.sh` |
| Pero is ready without Telegram or providers, and keeps running when they fail | `test/control.e2e-spec.ts` |
| One daemon runs per workspace, and a killed one never blocks the next start | `test/lifecycle.e2e-spec.ts`; `test/control.e2e-spec.ts` |
| A CLI command never loads the database stack or the Telegram client | `test/cli.e2e-spec.ts`, with `test/fixtures/deny-daemon-deps.mjs` preloaded |
| One migration creates a schema that holds only state | `src/persistence/persistence.module.spec.ts`: a fresh database matches the entities, and the migration reverts cleanly; `src/persistence/entities/domain-entities.spec.ts`: no Agent, Workflow, or settings table, and the constraints on each state table |

### Conversations

| Behavior | Verified by |
|---|---|
| The first interactive `pero run` refuses to start without an installed, signed-in provider CLI, and writes the provider picked to `Pero.md` | `src/cli/setup/first-run.spec.ts`; `src/settings-files/note-writer.spec.ts`: the commented `provider` line becomes the property |
| `pero service install` writes a systemd user unit or launchd agent that runs `pero run --foreground`, and starts it | `src/cli/system-service.spec.ts`, against recorded `systemctl`, `loginctl`, and `launchctl` calls |
| Creating a topic in an allowed forum group onboards a new Agent that answers there | `test/interactive.e2e-spec.ts`; onboarding edge cases in `src/channels/note-agents.spec.ts` and `src/channels/channel-onboarding.spec.ts` |
| Two topics keep separate contexts while working in the same shared folder | `test/interactive.e2e-spec.ts`: separate Agents, Sessions, and provider sessions, both in the default folder |
| An Agent with its own folder works there | `test/interactive.e2e-spec.ts`; `test/agent-notes.e2e-spec.ts` |
| The General topic and a direct chat reach the main Agent in separate Sessions | `test/interactive.e2e-spec.ts` |
| A follow-up resumes the right provider session after a restart | `test/interactive.e2e-spec.ts`: each of four Channels resumes its own provider session in a new daemon; real resume from another process in both smoke tests |
| A new provider or folder starts a fresh Session that carries over recent messages; a new model or effort continues it | `test/interactive.e2e-spec.ts`; `test/agent-notes.e2e-spec.ts`; `test/channels.e2e-spec.ts` for a Channel moved to another Agent |
| Each Channel's history holds the text sent and received there, and nothing else | `test/interactive.e2e-spec.ts`; `test/channels.e2e-spec.ts`; `src/agents/agent-manager.spec.ts` |
| A chat that is not allowed invokes no runtime, creates no Agent, and gets only the pairing hint | `test/interactive.e2e-spec.ts`; `test/telegram.e2e-spec.ts`; `src/channels/channel-router.spec.ts` |
| Codex and Claude subscription sign-ins each have a documented SDK smoke test under the service's account | `test/smoke/claude-runtime.smoke-spec.ts` and `test/smoke/codex-runtime.smoke-spec.ts`, run as in [the section above](#provider-smoke-tests-under-the-services-account) |

### Notes and configuration

| Behavior | Verified by |
|---|---|
| `pero check` validates any workspace with or without Pero, including in CI | `test/check.e2e-spec.ts`: without Pero, including `--json`; `test/settings-notes.e2e-spec.ts`: topic titles through the daemon; `src/settings-files/check.spec.ts` and `src/settings-files/snapshot.spec.ts`; the CI step that checks the example workspace |
| The running daemon keeps an up-to-date snapshot of the notes, and `pero status` reports broken ones | `src/settings-files/reload.spec.ts`: an edit within one scan, a note caught mid-write, last good versions, and 500 notes; `src/settings/settings-notes.service.spec.ts` and `test/settings-notes.e2e-spec.ts`: the `settings` component |
| Runtime code reads definitions synchronously, loaded before anything reads them | `src/settings/definitions.spec.ts`; `src/settings/settings-notes.service.spec.ts`: the notes load before the startup of modules that read them |
| Agents, their prompts, defaults, and which topic each answers are configured only by notes, and changes apply within 10 seconds | `test/agent-notes.e2e-spec.ts`: edits of the body, model, effort, provider, folder, `Pero.md`, and `topics`; `src/channels/note-agents.spec.ts`: routing by `topics`; `test/cli.e2e-spec.ts`: no command changes them |
| New topics create notes | `src/channels/note-agents.spec.ts`: one note when the topic's creation and first message race, the template, numbering, renames, and `new-topics: main-agent`; `test/example-workspace.e2e-spec.ts` |
| State refers to Agents and Workflows by name | `src/persistence/entities/domain-entities.spec.ts`: Sessions, messages, and runs name Agents and Workflows that no row holds, and one schedule row per Workflow name |
| Claude `ask` Agents can't change configuration without asking | `src/runtimes/claude/edit-policy.spec.ts`: an edit under the settings folder, through a symlink or `../`, asks; `src/runtimes/claude/claude-runtime.spec.ts`: refused in a Workflow run; the Claude smoke test |
| Broken notes are reported in Telegram once | `src/notifications/broken-note-reports.spec.ts`: once per broken version, nothing for a fix, one message per Channel, and only logs at startup; `test/workflows.e2e-spec.ts`: in the Workflow's Channel |
| Allowed chats can be changed by editing `config.yaml` | `src/host-config/host-config.service.spec.ts`: chats added or removed by hand are served or turned away from the next look, and a broken edit keeps the last valid version; `test/cli.e2e-spec.ts`: `telegram allow` and `deny` edit the file while Pero is stopped, and an invalid file stops startup |
| Committing the workspace commits `config.yaml` and nothing secret | `scripts/check-packed-install.sh`: `git add -A` in a running workspace stages `config.yaml` and the notes, not `.env`, the database, logs, or `run/`; `test/cli.e2e-spec.ts` and `src/config/env-file.spec.ts`: `pero status` reports a `.env` Git would commit |

### Workflows and Notifications

| Behavior | Verified by |
|---|---|
| Workflows, their schedules, prompts, and targets are configured only by notes | `test/workflows.e2e-spec.ts`: Workflows served from their notes, each edit applying, across a restart; `test/cli.e2e-spec.ts`: no command changes them |
| Schedule edits apply within 10 seconds without spurious catch-up runs | `src/scheduler/schedule-tick.spec.ts`: an edit moves the next run at once, a changed schedule catches nothing up, and a renamed note starts afresh; `test/workflows.e2e-spec.ts` |
| A missed scheduled run is found after restart | `test/workflows.e2e-spec.ts`: one catch-up run for the times a schedule missed while Pero was down; `src/scheduler/schedule-tick.spec.ts`: missed times, and catch-up only for notes that still exist and are enabled |
| Duplicate polls create one run per trigger occurrence | `src/scheduler/schedule-tick.spec.ts`: one run per time however often it polls, and when polls overlap |
| An interrupted run is visibly recorded and handled according to its policy | `test/workflows.e2e-spec.ts`: a run Pero stopped is recorded interrupted and retried as its Workflow allows, and cancellation; `src/workflows/workflow-runs.spec.ts` |
| A scheduled Workflow reads each message in its Channel history window exactly once across runs | `src/workflows/workflow-runs.spec.ts`: adjacent windows across consecutive runs, and a retry reading the window of the run it retries; `test/restore.e2e-spec.ts` across a restore |
| A Workflow can notify a configured topic | `test/workflows.e2e-spec.ts`: notifies the Channels a Workflow names; `src/notifications/run-notifications.spec.ts` |
| A daily Workflow can review the previous day's chats and deliver suggestions to a chosen topic, where the owner can reply to them | `test/restore.e2e-spec.ts`: a Workflow reading every Channel's history notifies a topic, and the next message there receives its suggestion; `test/workflows.e2e-spec.ts`: the next turn receives a delivered Notification |
| A temporary Telegram delivery failure remains visible and retries without creating duplicate Workflow Runs | `test/workflows.e2e-spec.ts`: delivers a Notification once Telegram is back, and keeps Notifications across a restart; `src/notifications/notification-delivery.spec.ts`: retries after backoff without another run |

### Backup and restore

| Behavior | Verified by |
|---|---|
| Restore brings back definitions and resumable Sessions | `test/restore.e2e-spec.ts`, which follows the drill in [Operating Pero](./OPERATIONS.md#moving-to-a-fresh-machine): the notes come back with the cloned workspace and the state with the backup, every Channel resumes its provider session, and a Channel whose provider conversation is gone continues in a fresh Session with its history |
| Backups restore into a cloned workspace | `test/restore.e2e-spec.ts`: a workspace restored into a fresh clone at its path, with its data folder; `test/cli.e2e-spec.ts`: a clone keeps its `config.yaml` and data files; `src/cli/restore.spec.ts`; `scripts/check-packed-install.sh`: a `git clone` |
