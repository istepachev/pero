# pero
Pero — open-source Personal Agent Runtime for running an always-on AI assistant on your VPS — Telegram, scheduled tasks, tools, background workflows, and proactive messaging. It runs on your existing Claude or Codex subscription.

```sh
npm install -g @perokit/pero
pero run
```

Repository: https://github.com/perokit/pero

## Development

Requires Node.js 22.17+ or 24.11+; development uses Node 24 (see `.nvmrc`).

```sh
npm ci
npm run build          # compile to dist/
npm run start:dev      # daemon in watch mode on ./.pero
npm run cli -- --help  # built `pero` CLI
npm test               # unit tests (Vitest)
npm run test:e2e       # builds, then runs e2e tests
npm run test:smoke     # builds, then runs real Claude and Codex turns when enabled
npm run lint           # oxlint
bash scripts/check-packed-install.sh  # install the npm pack artifact globally and drive it
```

[Testing](./docs/TESTING.md) describes each test layer, how to run the provider smoke tests as the account the service runs as, how to check a real bot by hand, and where each Phase 2 exit criterion is verified.

### Bootstrap configuration

| Setting | Source | Default |
|---|---|---|
| Data directory | `--data-dir` (any `pero` command, before or after its name), then `PERO_HOME` | `~/.pero` |
| Log level | `PERO_LOG_LEVEL` (`fatal` … `trace`) | `info` |
| Telegram bot token | `PERO_TELEGRAM_BOT_TOKEN` in the daemon's environment, then `secrets/telegram-bot-token` | none |
| Telegram Bot API server | `PERO_TELEGRAM_API_ROOT`, such as a [local Bot API server](https://github.com/tdlib/telegram-bot-api) | `https://api.telegram.org` |
| Echo runtime, for testing only | `PERO_FAKE_RUNTIME=echo`: every Agent answers `echo: <message>` instead of running Claude or Codex | unset |

The daemon creates the data directory (`logs/`, `run/`, `secrets/`) owner-only on startup and appends JSON logs to `logs/pero.log`; `--foreground` also writes them to stdout. Invalid values stop startup with a message naming the setting.

### Running the daemon

```sh
npm run cli -- run --data-dir .pero     # start in the background; waits until ready
npm run cli -- status --data-dir .pero  # process, health, and components
npm run cli -- stop --data-dir .pero    # graceful stop; waits until it exits
npm run cli -- logs -f --data-dir .pero # recent log entries, then new ones
npm run cli -- run --foreground --data-dir .pero  # attached; logs to stdout
```

`pero run` starts the daemon detached in its own session, so it keeps running after the terminal closes, and reports the running daemon instead of starting a second one. The daemon's own stdout and stderr (startup errors, crashes) go to `logs/daemon.out`; on a failed start, `pero run` prints that output and both log paths. `pero stop` and a repeated `pero run` are safe when there is nothing to do. `pero status` exits 3 when Pero is stopped. Commands that need the daemon fail with `Pero isn't running — start it with pero run` rather than starting it.

`pero logs` prints the last 50 entries of `logs/pero.log` as readable lines in local time (`-n <count>` for more or fewer); `--follow` keeps streaming new entries, waiting for the file if Pero has not written it yet, and `--json` prints the raw lines for `jq`. It reads files only, so it works whether or not the daemon is running. It does not stream `logs/daemon.out`, but it names that file on stderr when it has content.

### First-run setup and settings

The daemon starts even when nothing is configured, reporting what is missing as degraded. `pero run` then checks what is still needed: the default working directory all Agents share, the Telegram bot token, and sign-in for the providers in use (the default provider, plus any provider an Agent uses). On a terminal it asks for each one: the folder is prefilled with the current folder (`~/workspace` when started from home) and created if missing, the token is typed hidden, and it waits while you run `claude auth login` or `codex login` elsewhere. Without a terminal it prints the missing settings with the commands that fix them and returns at once.

```sh
npm run cli -- settings --data-dir .pero                       # show everything
npm run cli -- settings set default-working-directory ~/notes --data-dir .pero
printf '%s' "$TOKEN" | npm run cli -- settings set telegram-bot-token --data-dir .pero
npm run cli -- settings set shared-instructions --data-dir .pero < persona.md
npm run cli -- settings unset claude.model --data-dir .pero    # back to the provider default
```

Keys: `default-provider`, `claude.model`, `claude.effort`, `codex.model`, `codex.effort`, `default-working-directory`, `shared-instructions`, `history-carryover`, `default-permissions`, `timezone`, `max-concurrent-runs`, `telegram-bot-token`. A value left out is read from a prompt on a terminal, otherwise from stdin; the token is never accepted as an argument. It is stored owner-only in `secrets/telegram-bot-token` and never shown or logged. Changes apply without a restart.

### Telegram

#### Recommended setup

Pero talks to you in a private Telegram group with topics, where each topic is a conversation with an Agent of its own:

1. Create a bot with [@BotFather](https://t.me/BotFather) and give Pero its token: an interactive `pero run` asks for it, or `pero settings set telegram-bot-token` reads it from a prompt or stdin.
2. Create a private group and turn on Topics in its settings. Telegram gives the group a new chat ID when topics are turned on; Pero follows it.
3. Add the bot to the group as an administrator. Otherwise Telegram shows it only commands, mentions, and replies, unless you turn off its privacy mode with @BotFather `/setprivacy`.
4. Allow the group. Write anything in it: the bot answers with the group's chat ID and the command to run on the host, `pero telegram allow <chat-id>`. An interactive `pero run` waits for that message and offers to allow the chat itself.
5. Create a topic for each conversation you want. Each new topic onboards a new Agent named after it, working in the default working directory, and the bot posts which one answers there. The General topic talks to the main Agent.
6. Optionally, allow a direct chat with the bot too: message the bot, then allow your user ID the same way. It also talks to the main Agent, in a conversation separate from the General topic.

Before signing in to a provider, you can try the whole setup with the echo runtime: `PERO_FAKE_RUNTIME=echo pero run` (see [Checking a real bot by hand](./docs/TESTING.md#checking-a-real-bot-by-hand)).

#### How it works

With a bot token set, the daemon long-polls Telegram for messages and membership changes; readiness never waits for it. `pero status` shows `telegram ok Connected as @<bot>` once connected and serving a chat, and `degraded` while connecting, while no chat is allowed, when Telegram can't be reached, when another process polls the same bot, or when the bot is not an administrator of an allowed group (Telegram then shows it only commands, mentions, and replies). A token Telegram rejects shows as `unconfigured`, like a missing one. Replies go to the topic they answer; the General topic, a group without topics, and a direct chat are answered without a topic. Long replies are split into several messages. Other bots' messages are ignored. When enabling topics gives a group a new chat ID, Pero moves its allowlist entry and Channel to the new ID.

Pero serves only the chats allowed on its host. A chat it does not serve gets, at most once an hour, a reply naming its chat ID and the command that allows it:

```sh
npm run cli -- telegram --data-dir .pero                         # the bot, allowed chats, and chats that asked to pair
npm run cli -- telegram allow -1001234567890 --data-dir .pero    # a group (negative ID) or a direct chat (your user ID)
npm run cli -- telegram deny -1001234567890 --data-dir .pero     # its Channels and Agents stay for when it is allowed again
```

`pero telegram chats` shows for each allowed group whether topics are on and whether the bot is an administrator. `pero status` shows Telegram `degraded` while no chat is allowed. Once the token works, an interactive `pero run` explains how to set up a group or a direct chat, waits for the first message to the bot, and offers to allow that chat; a non-interactive one lists `pero telegram allow` among what is missing.

Each topic, General topic, and direct chat is a Channel, created with its Agent when it first reaches Pero. `pero channels` lists them by ID:

```sh
npm run cli -- channels --data-dir .pero                  # each Channel with its Agent
npm run cli -- channels assign 3 main --data-dir .pero    # topic 3 now talks to main, starting with its recent messages
npm run cli -- channels disable 3 --data-dir .pero        # ignore it, without onboarding it again; enable brings it back
npm run cli -- channels history 3 -n 50 --data-dir .pero  # its latest messages
```

### Workflows

A Workflow is work an Agent does on its own: the Agent, and the input each run sends it. Triggers start it, on a cron schedule in a time zone or by hand. A schedule queues a run within about 10 seconds of each time it comes due. Times missed while Pero was down become one catch-up run when it starts again, which records how many it stands for; so do times that come due while the previous run of the same schedule is still waiting to start. A schedule whose Workflow or Agent is disabled passes its times without a run. Each run starts a provider conversation of its own, apart from every Channel's Session and history, with the Agent's settings as they were when the run started. At most `max-concurrent-runs` run at once (default 2), and one at a time per Workflow.

A run Pero stops before it finishes, by crashing or through `pero stop` once the shutdown timeout has passed, is recorded `interrupted` when Pero starts again. Its Agent may already have changed files, so it is not started again unless the Workflow allows more than one attempt (`--max-attempts <n>`, at most 10); then it is queued again as a new run with the next attempt number, until it has started that often. `pero runs cancel <id>` cancels a run: one waiting to start never does, and a running one has its Agent's turn stopped.

A Workflow can read Channel history as its input, so an Agent can review your chats on a schedule. With `--history`, each run puts a transcript of what people wrote in every Channel since the previous successful run (the last 24 hours for the first) in place of `{{history}}` in its input, or after the input. The next run starts where that one ended, so each message is read once, and a retry reads the same messages as the run it retries. `--history-channels 3,5` reads only those Channels, `--history-messages all` adds the Agents' replies, and `--history-hours <n>` reads a fixed window instead. A run with no messages to read completes without its Agent unless `--run-when-empty` is given. The longest transcripts keep their newest messages and say how many older ones they left out.

A Workflow can notify Channels of its runs: `pero workflows notify <workflow> <channel>` (a Channel ID from `pero channels ls`) makes each run that finishes leave a Notification for that Channel, holding the Agent's answer under the Workflow's title, or why the run failed; an interrupted run that is retried leaves none, and its retry does. Cancelled runs and runs skipped for an empty history window notify no one. `--remove` stops it. Notifications are recorded together with the run's final status and stay pending; delivering them to Telegram comes next.

```sh
npm run cli -- workflows create evening-review --agent coach --input "Review today's chats" --data-dir .pero
npm run cli -- triggers add evening-review --cron "0 21 * * *" --data-dir .pero   # 21:00 in the timezone setting
npm run cli -- workflows show evening-review --data-dir .pero                      # its Agent, input, and Triggers
npm run cli -- triggers add evening-review --manual --data-dir .pero                # allow runs by hand
npm run cli -- workflows run evening-review --data-dir .pero                       # run it now and print the answer
npm run cli -- workflows edit evening-review --max-attempts 2 --data-dir .pero     # start a run Pero stopped once more
npm run cli -- runs cancel 7 --data-dir .pero                                      # cancel run 7
npm run cli -- workflows disable evening-review --data-dir .pero                   # keep it, and its Triggers, without running
npm run cli -- workflows create english --agent english-coach --history --input "Suggest better English for: {{history}}" --data-dir .pero
npm run cli -- triggers add english --cron "0 21 * * *" --data-dir .pero           # review the day's chats every evening
npm run cli -- workflows notify english 5 --data-dir .pero                         # post its suggestions to Channel 5
```

### Claude Agents

Claude Agents run Claude Code through the Claude Agent SDK, signed in with the Claude Code sign-in of the account running Pero (`claude auth login`). Pero never passes `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` on, so a key in the daemon's environment cannot switch the owner to API billing. An Agent works in its folder like Claude Code does: Claude Code's own system prompt with the Agent's instructions appended, and the owner's user, project, and local Claude Code settings, so the folder's `CLAUDE.md`, skills, and MCP servers apply. A turn refused as signed out marks the provider `degraded` in `pero status` until a turn succeeds again.

Each Agent's tools run under one of two permission modes, copied from `default-permissions` when it is created:

- `ask` (the default): reading and editing files in the Agent's folder runs freely; any other tool that needs permission, such as a shell command or a web fetch, asks in the Channel: Pero posts what the Agent wants to run with Allow and Deny buttons, which anyone in the chat may press, and marks the message with who answered. A request not answered within 10 minutes, whose turn ends, or still open when Pero stops is denied. Requests are not part of the Channel's history.
- `bypass`: every tool runs without asking, like `claude --dangerously-skip-permissions`. Claude Code refuses this mode when it runs as root unless `IS_SANDBOX=1` is set.

The smoke test runs real turns as the current account, using a little of its subscription: `PERO_SMOKE_CLAUDE=1 npm run test:smoke`. It builds first, then creates a session that writes a file, resumes it from another process with a different model and effort, checks that an `ask` Agent's command is refused, and aborts a turn. Run it as the account the service runs as, as [Testing](./docs/TESTING.md#provider-smoke-tests-under-the-services-account) describes, so that it checks the sign-in Pero will use.

### Codex Agents

Codex Agents run Codex through the Codex SDK, which bundles its own Codex CLI, signed in with the ChatGPT sign-in of the account running Pero (`codex login`, or `codex login --device-auth` on a headless host). Pero never passes `OPENAI_API_KEY` or `CODEX_API_KEY` on and forces the ChatGPT sign-in, so neither an environment variable nor a stored API-key login can switch the owner to API billing. An Agent works in its folder like the Codex CLI does: the owner's `~/.codex/config.toml` and the folder's `AGENTS.md` apply, and the Agent's instructions are added as developer instructions. A turn refused as signed out marks the provider `degraded` in `pero status` until a turn succeeds again.

Codex works only in a Git repository. For a folder that is not one, such as a notes vault, run `git init` there, or let the Agent skip the check with `pero agents edit <name> --skip-git-repo-check`; until then its turns are refused with that advice.

Codex runs each turn without a way to ask the owner, so the permission modes map to its sandbox instead:

- `ask`: Codex's `workspace-write` sandbox. The Agent reads anywhere, and edits files and runs commands only in its own folder, without network access; anything else fails and the Agent says why. It is never asked about, so Telegram approval buttons do not apply to Codex Agents. On Linux the sandbox needs unprivileged user namespaces, which Ubuntu 24.04 and later restrict by default through AppArmor; there `ask` Agents cannot write at all until that is allowed (`codex sandbox -- true` checks it).
- `bypass`: no sandbox, like `codex --dangerously-bypass-approvals-and-sandbox`.

The smoke test runs real turns as the current account: `PERO_SMOKE_CODEX=1 npm run test:smoke` (set `PERO_SMOKE_CODEX_MODEL` to change the model the resumed turn switches to, `gpt-5.5` by default). It creates a thread that writes a file, resumes it from another process with a different model and effort, checks that a folder outside Git is refused unless the Agent skips the check, checks the `ask` sandbox where it runs, aborts a turn, and checks that a signed-out Codex is reported as such. As with Claude, run it as the account the service runs as ([Testing](./docs/TESTING.md#provider-smoke-tests-under-the-services-account)).

The daemon has no network port. Once ready, it answers on the owner-only control socket `run/pero.sock`, one JSON line per request (`echo '{"op":"status"}' | nc -U -N .pero/run/pero.sock`); the CLI is a client of that socket and never opens the database.

One daemon runs per data directory. It holds a lock on `run/pero.lock` for as long as it runs; a second daemon exits with `Pero is already running for <dir>`. The lock is released by the OS however the daemon ends, so a crashed or killed daemon never blocks the next start. Once ready, the daemon records its pid, version, and socket in `run/pero.json`; that file counts only while the socket answers with the same pid.

The `shutdown` operation, SIGTERM, and SIGINT (Ctrl-C) stop the daemon the same way: it stops intake, waits up to 30 s for active work, closes the database, removes the socket and `run/pero.json`, and exits. `run/pero.lock` stays in place. A second signal exits immediately.

### Backup and restore

```sh
npm run cli -- backup ~/backups/pero.tgz --data-dir .pero        # while Pero runs
npm run cli -- restore ~/backups/pero.tgz --data-dir /srv/pero   # while it is stopped
```

`pero backup <file>` asks the running daemon for a backup. The daemon copies the database with SQLite's online backup API, so recent work still in the WAL is included and Pero keeps working meanwhile, then writes a gzip tar with that snapshot, `secrets/`, and a manifest. The archive is owner-only and replaces any file already at that path; it must be outside the data directory. It includes the Telegram bot token when one is stored (one from `PERO_TELEGRAM_BOT_TOKEN` is not), so keep it as private as the data directory. Logs and `run/` are left out.

Working folders are not in the backup: they are yours, and a notes vault may already sync elsewhere. Back them up yourself. The manifest records the folders the settings and Agents point to.

`pero restore <file>` runs without the daemon. It needs a data directory that is missing or empty, so it never overwrites an installation: to restore over one, stop Pero and move its folder aside first. It unpacks the archive next to the target and renames it into place in one step, then warns about each recorded working folder that does not exist on this machine. Start the restored installation with `pero run`; it applies any newer migrations as usual.

Design docs live in [docs/](./docs/README.md).
