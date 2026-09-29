# Pero user guide

How Pero behaves once it is installed: first-run setup and settings, Telegram, Agents and their permissions, and Workflows. For installing, upgrading, backups, and running Pero as a service, see [Operating Pero](./OPERATIONS.md); for every command and option, see the [CLI reference](./CLI.md).

## Running Pero

```sh
pero run                # start in the background; waits until ready
pero status             # process, health, and components
pero stop               # graceful stop; waits until it exits
pero logs -f            # recent log entries, then new ones
pero run --foreground   # attached; logs to stdout
```

`pero run` starts Pero detached in its own session, so it keeps running after the terminal closes, and reports the running Pero instead of starting a second one. Pero's own stdout and stderr (startup errors, crashes) go to `logs/daemon.out`; on a failed start, `pero run` prints that output and both log paths. `pero stop` and a repeated `pero run` are safe when there is nothing to do. `pero status` exits 3 when Pero is stopped. Commands that need Pero running fail with `Pero isn't running — start it with pero run` rather than starting it.

`pero logs` prints the last 50 entries of `logs/pero.log` as readable lines in local time (`-n <count>` for more or fewer); `--follow` keeps streaming new entries, waiting for the file if Pero has not written it yet, and `--json` prints the raw lines for `jq`. It reads files only, so it works whether or not Pero is running. It does not stream `logs/daemon.out`, but it names that file on stderr when it has content.

Every command takes `--data-dir <dir>` to use a data directory other than `~/.pero`; see [Configuration](./OPERATIONS.md#configuration).

## First-run setup and settings

Pero starts even when nothing is configured, reporting what is missing as degraded. `pero run` then checks what is still needed: the default working directory all Agents share, the Telegram bot token, and sign-in for the providers in use (the default provider, plus any provider an Agent uses). On a terminal it asks for each one: the folder is prefilled with the current folder (`~/workspace` when started from home) and created if missing, the token is typed hidden, and it waits while you run `claude auth login` or `codex login` elsewhere. Without a terminal it prints the missing settings with the commands that fix them and returns at once.

```sh
pero settings                                           # show everything
pero settings set default-working-directory ~/notes
printf '%s' "$TOKEN" | pero settings set telegram-bot-token
pero settings set shared-instructions < persona.md
pero settings unset claude.model                        # back to the provider default
```

Keys: `default-provider`, `claude.model`, `claude.effort`, `codex.model`, `codex.effort`, `default-working-directory`, `shared-instructions`, `main-agent`, `history-carryover`, `history-retention-days`, `default-permissions`, `timezone`, `max-concurrent-runs`, `telegram-bot-token`. A value left out is read from a prompt on a terminal, otherwise from stdin; the token is never accepted as an argument. It is stored owner-only in `secrets/telegram-bot-token` and never shown or logged. Changes apply without a restart.

## Telegram

### Set up Telegram

Pero talks to you in a private Telegram group with topics, where each topic is a conversation with an Agent of its own:

1. Create a bot with [@BotFather](https://t.me/BotFather) and give Pero its token: an interactive `pero run` asks for it, or `pero settings set telegram-bot-token` reads it from a prompt or stdin.
2. Create a private group and turn on Topics in its settings. Telegram gives the group a new chat ID when topics are turned on; Pero follows it.
3. Add the bot to the group as an administrator. Otherwise Telegram shows it only commands, mentions, and replies, unless you turn off its privacy mode with @BotFather `/setprivacy`.
4. Allow the group. Write anything in it: the bot answers with the group's chat ID and the command to run on the host, `pero telegram allow <chat-id>`. An interactive `pero run` waits for that message and offers to allow the chat itself.
5. Create a topic for each conversation you want. Each new topic onboards a new Agent named after it, working in the default working directory, and the bot posts which one answers there. The General topic talks to the main Agent.
6. Optionally, allow a direct chat with the bot too: message the bot, then allow your user ID the same way. It also talks to the main Agent, in a conversation separate from the General topic.

Before signing in to a provider, you can try the whole setup with the echo runtime: `PERO_FAKE_RUNTIME=echo pero run` (see [Checking a real bot by hand](./TESTING.md#checking-a-real-bot-by-hand)).

### How it works

With a bot token set, Pero long-polls Telegram for messages and membership changes. `pero status` shows `telegram ok Connected as @<bot>` once connected and serving a chat, and `degraded` while connecting, while no chat is allowed, when Telegram can't be reached, when another process polls the same bot, or when the bot is not an administrator of an allowed group (Telegram then shows it only commands, mentions, and replies). A token Telegram rejects shows as `unconfigured`, like a missing one. Replies go to the topic they answer; the General topic, a group without topics, and a direct chat are answered without a topic. Long replies are split into several messages. Other bots' messages are ignored. When enabling topics gives a group a new chat ID, Pero moves its allowlist entry and Channel to the new ID.

### Allowed chats

Pero serves only the chats allowed on its host. A chat it does not serve gets, at most once an hour, a reply naming its chat ID and the command that allows it:

```sh
pero telegram                         # the bot, allowed chats, and chats that asked to pair
pero telegram allow -1001234567890    # a group (negative ID) or a direct chat (your user ID)
pero telegram deny -1001234567890     # its Channels and Agents stay for when it is allowed again
```

`pero telegram chats` shows for each allowed group whether topics are on and whether the bot is an administrator. Once the token works, an interactive `pero run` explains how to set up a group or a direct chat, waits for the first message to the bot, and offers to allow that chat; a non-interactive one lists `pero telegram allow` among what is missing.

### Channels and history

Each topic, General topic, and direct chat is a Channel, created with its Agent when it first reaches Pero. `pero channels` lists them by ID:

```sh
pero channels                  # each Channel with its Agent
pero channels assign 3 main    # topic 3 now talks to main, starting with its recent messages
pero channels disable 3        # ignore it, without onboarding it again; enable brings it back
pero channels history 3 -n 50  # its latest messages
```

Pero keeps each Channel's message history until you set `history-retention-days`: then messages older than that many days are deleted within the hour, and every hour after, including when Pero starts. `pero settings unset history-retention-days` keeps everything again. Workflow Runs and Notifications keep their own text, such as an Agent's answer, whatever the setting. [Operating Pero](./OPERATIONS.md#message-history) describes exactly what the history keeps.

## Agents

```sh
pero agents                     # every Agent, with its provider, model, folder, and permissions
pero agents show notes          # its settings and Channels
pero agents create coach --provider claude --instructions "You are my running coach."
pero agents edit coach --provider codex --working-directory ~/training
pero agents disable coach
```

An Agent without its own folder follows the default working directory. Changing an Agent's provider or folder makes its next turn in each Channel start a fresh Session that carries over the Channel's recent messages; model, effort, and instructions apply from the next turn of the same Session.

### Claude Agents

Claude Agents run Claude Code through the Claude Agent SDK, signed in with the Claude Code sign-in of the account running Pero (`claude auth login`). Pero never passes `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` on, so a key in Pero's environment cannot switch you to API billing. An Agent works in its folder like Claude Code does: Claude Code's own system prompt with the Agent's instructions appended, and your user, project, and local Claude Code settings, so the folder's `CLAUDE.md`, skills, and MCP servers apply. A turn refused as signed out marks the provider `degraded` in `pero status` until a turn succeeds again.

Each Agent's tools run under one of two permission modes, copied from `default-permissions` when it is created:

- `ask` (the default): reading and editing files in the Agent's folder runs freely; any other tool that needs permission, such as a shell command or a web fetch, asks in the Channel: Pero posts what the Agent wants to run with Allow and Deny buttons, which anyone in the chat may press, and marks the message with who answered. A request not answered within 10 minutes, whose turn ends, or still open when Pero stops is denied. Requests are not part of the Channel's history.
- `bypass`: every tool runs without asking, like `claude --dangerously-skip-permissions`. Claude Code refuses this mode when it runs as root unless `IS_SANDBOX=1` is set.

### Codex Agents

Codex Agents run Codex through the Codex SDK, which bundles its own Codex CLI, signed in with the ChatGPT sign-in of the account running Pero (`codex login`, or `codex login --device-auth` on a headless host). Pero never passes `OPENAI_API_KEY` or `CODEX_API_KEY` on and forces the ChatGPT sign-in, so neither an environment variable nor a stored API-key login can switch you to API billing. An Agent works in its folder like the Codex CLI does: your `~/.codex/config.toml` and the folder's `AGENTS.md` apply, and the Agent's instructions are added as developer instructions. A turn refused as signed out marks the provider `degraded` in `pero status` until a turn succeeds again.

Codex works only in a Git repository. For a folder that is not one, such as a notes vault, run `git init` there, or let the Agent skip the check with `pero agents edit <name> --skip-git-repo-check`; until then its turns are refused with that advice.

Codex runs each turn without a way to ask you, so the permission modes map to its sandbox instead:

- `ask`: Codex's `workspace-write` sandbox. The Agent reads anywhere, and edits files and runs commands only in its own folder, without network access; anything else fails and the Agent says why. It is never asked about, so Telegram approval buttons do not apply to Codex Agents. On Linux the sandbox needs unprivileged user namespaces, which Ubuntu 24.04 and later restrict by default through AppArmor; there `ask` Agents cannot write at all until that is allowed (`codex sandbox -- true` checks it).
- `bypass`: no sandbox, like `codex --dangerously-bypass-approvals-and-sandbox`.

## Workflows

A Workflow is work an Agent does on its own: the Agent, and the input each run sends it. Triggers start it, on a cron schedule in a time zone or by hand.

```sh
pero workflows create evening-review --agent coach --input "Review today's chats"
pero triggers add evening-review --cron "0 21 * * *"   # 21:00 in the timezone setting
pero workflows show evening-review                      # its Agent, input, and Triggers
pero triggers add evening-review --manual               # allow runs by hand
pero workflows run evening-review                       # run it now and print the answer
pero workflows edit evening-review --max-attempts 2     # start a run Pero stopped once more
pero workflows disable evening-review                   # keep it, and its Triggers, without running
```

### Schedules and runs

A schedule queues a run within about 10 seconds of each time it comes due. Times missed while Pero was down become one catch-up run when it starts again, which records how many it stands for; so do times that come due while the previous run of the same schedule is still waiting to start. A schedule whose Workflow or Agent is disabled passes its times without a run. Each run starts a provider conversation of its own, apart from every Channel's Session and history, with the Agent's settings as they were when the run started. At most `max-concurrent-runs` run at once (default 2), and one at a time per Workflow.

A run Pero stops before it finishes, by crashing or through `pero stop` once the shutdown timeout has passed, is recorded `interrupted` when Pero starts again. Its Agent may already have changed files, so it is not started again unless the Workflow allows more than one attempt (`--max-attempts <n>`, at most 10); then it is queued again as a new run with the next attempt number, until it has started that often.

```sh
pero runs            # the latest runs
pero runs show 7     # how run 7 ended, the history it read, and whom it notified
pero runs retry 7    # run a failed, interrupted, or cancelled run 7 again
pero runs cancel 7   # cancel run 7
```

`pero runs cancel <id>` cancels a run: one waiting to start never does, and a running one has its Agent's turn stopped. `pero runs retry <id>` queues a failed, interrupted, or cancelled run again as a new run with the next attempt, whatever `--max-attempts` allows, reading the same Channel history.

### Reading chat history

A Workflow can read Channel history as its input, so an Agent can review your chats on a schedule. With `--history`, each run puts a transcript of what people wrote in every Channel since the previous successful run (the last 24 hours for the first) in place of `{{history}}` in its input, or after the input. The next run starts where that one ended, so each message is read once, and a retry reads the same messages as the run it retries. `--history-channels 3,5` reads only those Channels, `--history-messages all` adds the Agents' replies, and `--history-hours <n>` reads a fixed window instead. A run with no messages to read completes without its Agent unless `--run-when-empty` is given. The longest transcripts keep their newest messages and say how many older ones they left out.

```sh
pero workflows create english --agent english-coach --history --input "Suggest better English for: {{history}}"
pero triggers add english --cron "0 21 * * *"   # review the day's chats every evening
pero workflows notify english 5                 # post its suggestions to Channel 5
```

### Notifications

`pero workflows notify <workflow> <channel>` (a Channel ID from `pero channels`) makes each run that finishes leave a Notification for that Channel, holding the Agent's answer under the Workflow's title, or why the run failed; an interrupted run that is retried leaves none, and its retry does. Cancelled runs and runs skipped for an empty history window notify no one. `--remove` stops it.

Notifications are recorded together with the run's final status and delivered to the Channel within seconds. While Telegram can't be reached, delivery retries with a growing wait for about a day before the Notification is marked failed. A Notification to a chat that is no longer allowed fails at once. A delivered Notification joins the Channel's history as a `workflow` message, and the next message you send there reaches the Agent with it, so you can reply to it: ask about a suggestion right where it was posted.

```sh
pero notifications --status failed   # Notifications that could not be delivered
pero notifications show 4            # its message, and what stands in the way of its delivery
pero notifications retry 4           # deliver Notification 4 now, or again with fresh attempts
```
