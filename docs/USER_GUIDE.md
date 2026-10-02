# Pero user guide

How Pero behaves once it is installed: first-run setup and settings, Telegram, Agents and their permissions, and Workflows. Every file and property is in [Configuring Pero](./CONFIGURATION.md); for installing, upgrading, backups, and running Pero as a service, see [Operating Pero](./OPERATIONS.md); for every command and option, see the [CLI reference](./CLI.md).

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

Every command works on the workspace found from the current folder (the nearest folder holding `.pero/`), or takes `--workspace <dir>` (`-w`) to name one. With none found, `pero run` on a terminal offers to make one in the current folder, or in `~/workspace` from the home folder. `pero init [dir]` makes one without starting Pero; it only fills in what's missing, so it also completes a cloned one. Other commands say which `pero init` to run. See [Configuration](./OPERATIONS.md#configuration).

## First-run setup and settings

The first `pero run` in a workspace on a terminal, before Pero has a database, settles the provider your Agents use. With both the Claude Code and Codex CLIs installed, it asks which one; with one, it uses it; with neither, it refuses to start and says how to install one. It then waits while that CLI is signed out (`claude auth login` or `codex login` in another terminal, then Enter), and refuses to start if you quit. The choice is written as `provider:` in `Pero.md`, unless `Pero.md` already sets one, which is then the one checked. With `PERO_FAKE_RUNTIME=echo` no provider is needed and none is asked for.

Pero starts even when nothing is configured, reporting what is missing as degraded. `pero run` then checks what is still needed: sign-in for the providers in use (the default provider, plus any provider an Agent uses), and the Telegram bot token. On a terminal it asks for each one, each step in a block of its own: the token shows as `*` while you type or paste it, and it waits while you run `claude auth login` or `codex login` elsewhere. Without a terminal it prints the missing settings with the commands that fix them and returns at once. After a first start, an interactive `pero run` offers to install Pero as a service (see [Operating Pero](./OPERATIONS.md#install-and-upgrade)); after a first start or any setup it ends with what `pero status` shows, so you can see that Pero is running and what each component reports. If you leave setup before it finishes, with Ctrl-C or by closing the terminal or connection, the Pero it started is stopped again; run `pero run` to pick up where you left off.

```sh
pero settings                                   # show everything
printf '%s' "$TOKEN" | pero telegram token      # set the bot token
```

The installation defaults are properties of `Pero.md` in the system folder; instructions every Agent shares are the main Agent's, in its note. The data folder is `data` in `.pero/config.yaml`. `pero settings` shows them. `pero telegram token` sets the Telegram bot token, read from a prompt on a terminal, otherwise from stdin, and never accepted as an argument. It goes owner-only into the workspace's `.env` and is never shown or logged. Changes apply without a restart.

Pero rereads the notes every 10 seconds, so an edit applies without a restart. A note with errors doesn't stop Pero: `pero status` counts it, and `pero check` lists each error. Since you may edit on your phone, Pero also posts once per broken version of a note in Telegram, in the topics it relates to (an Agent's `topic`, a Workflow's `channel`), or else in the main Agent's primary Channel. The message names each error and what Pero uses meanwhile: the note's last good version, if Pero read one since it started, or nothing. It isn't part of the topic's history. A fix is only logged, and a note already broken when Pero starts is left to `status` and `check`.

## Telegram

### Set up Telegram

Pero talks to you in a private Telegram group with topics, where each topic is a conversation with an Agent of its own:

1. Create a bot with [@BotFather](https://t.me/BotFather) and give Pero its token: an interactive `pero run` asks for it, or `pero telegram token` reads it from a prompt or stdin.
2. Create a private group and turn on Topics in its settings. Telegram gives the group a new chat ID when topics are turned on; Pero follows it. Keep the group private: anyone who can write in an allowed chat can talk to its Agents, so a public group, which anyone can find and join, is a danger that `pero status`, `pero telegram chats`, and `pero run` point out.
3. Add the bot to the group as an administrator. Otherwise Telegram shows it only commands, mentions, and replies, unless you turn off its privacy mode with @BotFather `/setprivacy`.
4. Allow the group. Write anything in it: the bot answers with the group's chat ID and the command to run on the host, `pero telegram allow <chat-id>`. An interactive `pero run` asks first whether you will use a private group (recommended) or a direct chat with the bot, shows the steps for that choice, then waits for that message and offers to allow the chat itself; meanwhile the bot answers that chat that it can be confirmed in the terminal. Once a chat that asked to pair is allowed, the bot posts the first steps there: which Agent answers, where its instructions are (`Agents/Main.md`, which every other Agent starts with), how topics get Agents of their own (or, in a direct chat, how to set up a group with topics), which time zone schedules use and where to change it and other defaults (`Pero.md`, where `pero init` sets the host's zone), and how to ask for a Workflow. A chat allowed otherwise, such as in `config.yaml` or before the bot connects, gets them with its first message.
5. Create a topic for each conversation you want. Each topic has an Agent of its own: the one whose note's `topic` is its title. A new topic gets a note of its own, `Agents/<Topic title>.md`, written from `Agents/_Template.md` when you add one ([the template](./CONFIGURATION.md#agent-notes)), or with `topic` alone, and the bot posts which Agent answers there. That Agent starts with the main Agent's instructions, then its own. Renaming a topic renames it in its note's `topic` too, so it keeps its Agent. The General topic talks to the main Agent, whose note Pero writes from the skeleton if it is missing.
6. Optionally, allow a direct chat with the bot too: message the bot, then allow your user ID the same way. It also talks to the main Agent, in a conversation separate from the General topic.

Before signing in to a provider, you can try the whole setup with the echo runtime: `PERO_FAKE_RUNTIME=echo pero run` (see [Checking a real bot by hand](./TESTING.md#checking-a-real-bot-by-hand)).

### How it works

With a bot token set, Pero long-polls Telegram for messages and membership changes. `pero status` shows `telegram ok Connected as @<bot>` once connected and serving a chat, and `degraded` while connecting, while no chat is allowed, when Telegram can't be reached, when another process polls the same bot, when the bot is not an administrator of an allowed group (Telegram then shows it only commands, mentions, and replies), or when an allowed group is public. A token Telegram rejects shows as `unconfigured`, like a missing one. Replies go to the topic they answer; the General topic, a group without topics, and a direct chat are answered without a topic. Long replies are split into several messages. Other bots' messages are ignored. When enabling topics gives a group a new chat ID, Pero moves its Channel and its entry in `config.yaml` to the new ID.

### Commands

Pero answers a few commands itself, in the topic or chat they are sent in; the bot lists them in Telegram's `/` menu. Neither a command nor Pero's answer joins the Channel's history, so no Agent or Workflow sees them. Any other `/word`, such as `/plan the week`, goes to the Agent as text. A command for another bot in the group, such as `/status@other_bot`, is ignored.

| Command | What it does |
|---|---|
| `/status` | The Agent that answers here: whether it is answering (and for how long, and how many messages wait), its note (`Config:`), provider, model, effort, permissions, and folder with where each comes from, its Session (when it started and how many turns it had), how full its context is, and its note's errors. Then each part of Pero and its state, as `pero status` shows them. Where no Agent answers, it says why and what to edit. |
| `/new` | Starts the conversation here over: the Agent's next answer begins a new provider conversation that carries over nothing from before `/new`, unlike a fresh Session after a provider change. An answer in progress is stopped. The history is kept, for Workflows and `pero channels history`. |
| `/stop` | Stops the Agent's answer in progress here, and the messages waiting behind it, which it never answers. Its open tool requests are denied. The conversation stays as it was. |
| `/model [name]` | Without a name, the Agent's model and where it comes from, with a button for each well-known one (`opus`, `sonnet`, and `haiku` for Claude) and each the workspace already uses. With a name, or by pressing one, Pero sets `model` in the Agent's note, keeping its comments; `default` removes it, so `Pero.md` or the provider decides. It applies from the Agent's next answer, in the same conversation. |
| `/effort [level]` | The same for `effort`, offering the levels of the Agent's provider; a level the provider doesn't have shows the choices again. |
| `/workflows [name]` | Each Workflow with when it runs next and how its latest run went, and a button for each. A Workflow's own screen shows its note, Agent, schedule, the topics it posts to, and its latest runs, with Run now and Runs. |
| `/run [name]` | Runs a Workflow now, as `pero workflows run` does. Without a name, or with one that matches no Workflow, it offers a button for each. A Workflow is named by its name or its title, in any case. |
| `/runs [name]` | The latest runs, or one Workflow's, with a button for each; a run's screen shows its times, error, and the start of its answer, with Cancel or Retry when they apply. `/runs #42` opens run 42. |
| `/cancel [id]` | Cancels a waiting or running run, as `pero runs cancel` does; without an ID, or with one that can't be cancelled, it offers those that can be. |
| `/retry [id]` | Runs a failed, interrupted, or cancelled run again, once, as `pero runs retry` does; without an ID it offers those that can be. |
| `/help` | Lists the commands. |

Some answers have buttons: `/status` offers Stop (while the Agent answers), New session, Refresh, Model, and Effort, `/help` the common commands, and the Workflow commands a button for each Workflow or run. Pressing one edits the same message rather than sending a new one, and a button that starts over asks first. Anyone in the chat may use the commands and their buttons, as with the Allow and Deny buttons. `/model` and `/effort` edit the note directly, so a Claude `ask` Agent's approval for settings edits doesn't apply; to change `permissions`, edit the note.

`/status` shows context only for Claude Agents: the tokens the conversation held after the latest answer, out of the model's context window. Codex reports only the tokens a whole turn used, which overstates the context, so the line is left out.

### Allowed chats

Pero serves only the chats allowed on its host. A chat it does not serve gets, at most once an hour, a reply naming its chat ID and the command that allows it:

```sh
pero telegram                         # the bot, allowed chats, and chats that asked to pair
pero telegram allow -1001234567890    # a group (negative ID) or a direct chat (your user ID)
pero telegram deny -1001234567890     # its Channels and Agents stay for when it is allowed again
```

`pero telegram chats` shows for each allowed group whether topics are on and whether the bot is an administrator, and warns of a public one. Once the token works, an interactive `pero run` explains how to set up a group or a direct chat, waits for the first message to the bot, and offers to allow that chat. For each allowed group where Telegram says the bot is not an administrator, it waits until the bot is made one; for each public group, it shows the danger and checks again once you have made it private. Enter or `s` skips either step, and the next `pero run` asks again. A non-interactive `pero run` lists all of these among what is missing.

### Channels and history

Each topic, General topic, and direct chat is a Channel, created when it first reaches Pero. Which Agent answers there follows the notes on every message: the main Agent (`main-agent` in `Pero.md`) answers General topics, groups without topics, and direct chats, and a topic goes to the Agent whose note's `topic` is its title. To move a topic, change `topic`; the new Agent's first turn starts with the topic's recent messages. To silence it, set `enabled: false` in its Agent's note. Where no Agent answers, such as a topic two notes claim, Pero replies once saying why. `pero channels` lists them by ID:

```sh
pero channels                  # each Channel with the Agent that answers there now
pero channels show 3           # who answers, or why no one does
pero channels history 3 -n 50  # its latest messages
```

`/new` starts a Channel's conversation over without carrying anything over (see [Commands](#commands)).

Pero keeps each Channel's message history until you set `history-retention-days` in `Pero.md`: then messages older than that many days are deleted within the hour, and every hour after, including when Pero starts. Removing it keeps everything again. Workflow Runs and Notifications keep their own text, such as an Agent's answer, whatever the setting. [Operating Pero](./OPERATIONS.md#message-history) describes exactly what the history keeps.

## Agents

An Agent is a note in the system folder's `Agents/` folder: its text is the Agent's instructions, and its properties choose its topic, provider, model, effort, permissions, and folder. Anything it leaves out comes from `Pero.md`. The main Agent's text is placed before every other Agent's instructions, unless the Agent sets `skip-main-instructions: true`. To add an Agent, add a note; to change one, edit it; to silence one, set `enabled: false`. The [configuration reference](./CONFIGURATION.md#agent-notes) lists every property.

```markdown
---
topic: Running
provider: codex
working-directory: projects/training
---
You are my running coach. My plan is in Plan.md.
```

```sh
pero agents                     # every Agent, with its note, topic, provider, model, folder, and permissions
pero agents show coach          # its values and where each comes from, its Channels, and its note's errors
```

An Agent without `working-directory` works in the workspace, where your scripts, Git repository, and other tools are. Pero tells every Agent where the data folder is, and that's where it keeps notes and other files it writes for you. Changing an Agent's provider or folder makes its next turn in each Channel start a fresh Session that carries over the Channel's recent messages; model, effort, and instructions apply from the next turn of the same Session.

### Asking an Agent to change settings

Every Agent knows where its own note, `Pero.md`, and the Workflows are, and reads Pero's guide for Agents (`.pero/guide.md`, which Pero writes on each start) before changing them. So you can manage Pero from Telegram:

- *"Create a Workflow that summarizes my health log every Sunday evening."* The Agent asks what it can't infer, such as the hour, the time zone, and which topic gets the summary, shows the note, and writes `Workflows/<Title>.md`.
- *"Be less formal"* or *"use opus"* changes that Agent's own note.
- *"How do Workflows read chat history?"* gets an answer from the guide.

A Claude Agent with `permissions: ask` asks you with Allow and Deny buttons before it writes anything in the system folder, and a Workflow run never changes settings. A broken note is reported in the chat as when you edit it yourself. The welcome Pero posts in a new topic names the Agent's note, if you'd rather edit it.

### Claude Agents

Claude Agents run Claude Code through the Claude Agent SDK, signed in with the Claude Code sign-in of the account running Pero (`claude auth login`). Pero never passes `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` on, so a key in Pero's environment cannot switch you to API billing. An Agent works in its folder like Claude Code does: Claude Code's own system prompt with the Agent's instructions appended, and your user, project, and local Claude Code settings, so the folder's `CLAUDE.md`, skills, and MCP servers apply. A turn refused as signed out marks the provider `degraded` in `pero status` until a turn succeeds again.

Each Agent's tools run under one of two permission modes, its note's `permissions`, or `Pero.md`'s:

- `ask` (the default): reading and editing files in the Agent's folder runs freely, except editing the system folder and Claude Code's, Git's, and the shell's own files there, such as `.claude/` and `.git/`, even through a symlink or a `../` path; those edits, and any other tool that needs permission, such as a shell command or a web fetch, ask in the Channel: Pero posts what the Agent wants to run with Allow and Deny buttons, which anyone in the chat may press, and marks the message with who answered. A request not answered within 10 minutes, whose turn ends, or still open when Pero stops is denied. Requests are not part of the Channel's history. A Workflow run has no one to ask, so it is refused such tools and can't change the system folder. Allow rules in your own Claude Code settings still apply before Pero is asked.
- `bypass`: every tool runs without asking, like `claude --dangerously-skip-permissions`. Claude Code refuses this mode when it runs as root unless `IS_SANDBOX=1` is set.

### Codex Agents

Codex Agents run Codex through the Codex SDK, which bundles its own Codex CLI, signed in with the ChatGPT sign-in of the account running Pero (`codex login`, or `codex login --device-auth` on a headless host). Pero never passes `OPENAI_API_KEY` or `CODEX_API_KEY` on and forces the ChatGPT sign-in, so neither an environment variable nor a stored API-key login can switch you to API billing. An Agent works in its folder like the Codex CLI does: your `~/.codex/config.toml` and the folder's `AGENTS.md` apply, and the Agent's instructions are added as developer instructions. A turn refused as signed out marks the provider `degraded` in `pero status` until a turn succeeds again.

Codex works only in a Git repository. For a folder that is not one, such as a notes vault, run `git init` there, or let the Agent skip the check with `skip-git-repo-check: true` in its note; until then its turns are refused with that advice.

Codex runs each turn without a way to ask you, so the permission modes map to its sandbox instead:

- `ask`: Codex's `workspace-write` sandbox. The Agent reads anywhere, and edits files and runs commands only in its own folder, without network access; anything else fails and the Agent says why. It is never asked about, so Telegram approval buttons do not apply to Codex Agents. On Linux the sandbox needs unprivileged user namespaces, which Ubuntu 24.04 and later restrict by default through AppArmor; there `ask` Agents cannot write at all until that is allowed (`codex sandbox -- true` checks it). The sandbox can't leave out a subfolder, so unlike a Claude Agent, a Codex `ask` Agent edits the system folder without asking when its folder contains it; give a Codex Agent that must not change configuration a `working-directory` outside the system folder.
- `bypass`: no sandbox, like `codex --dangerously-bypass-approvals-and-sandbox`.

## Workflows

A Workflow is work an Agent does on its own: a note in the system folder's `Workflows/` folder, whose text is the input each run sends the Agent. Its properties say when it runs and where its answer goes; the note's file name is its title, and its name is that title as a slug (`Evening review.md` is `evening-review`).

```markdown
---
hour: 21
agent: coach
channel: Coaching
max-attempts: 2
---
Review today's chats.
```

You can also ask an Agent to write one ([Asking an Agent](#asking-an-agent-to-change-settings)). `hour` (with `day` and `minute`), or `cron`, sets its schedule, in `Pero.md`'s `timezone` unless it sets its own; without one, it runs only by hand. `agent` names the Agent note that runs it; without it, the Agent that answers its first `channel` does, or the main Agent. `enabled: false` stops its schedule. Edits apply from the next run, within about 10 seconds; the [configuration reference](./CONFIGURATION.md#workflow-notes) lists every property.

```sh
pero workflows                      # each Workflow's schedule, next run, and Channels
pero workflows show evening-review  # its note, Agent, input, and schedule
pero workflows run evening-review   # run it now, whatever its schedule, and print the answer
```

### Schedules and runs

A schedule queues a run within about 10 seconds of each time it comes due. Times missed while Pero was down become one catch-up run when it starts again, which records how many it stands for; so do times that come due while the previous run of the same schedule is still waiting to start. An edited schedule applies as soon as Pero reads the note, from its next time, catching nothing up; so does a renamed note, which starts a history window of its own too. A schedule whose Agent is disabled passes its times without a run. Disabling or deleting a Workflow drops its schedule's saved times, so enabling it again catches nothing up, and cancels its runs waiting to start: those its schedule queued once it is disabled, all of them once it is deleted. A run under way finishes. Each run starts a provider conversation of its own, apart from every Channel's Session and history, with the Agent's settings as they were when the run started. At most `max-concurrent-runs` run at once (default 2), and one at a time per Workflow.

A run Pero stops before it finishes, by crashing or through `pero stop` once the shutdown timeout has passed, is recorded `interrupted` when Pero starts again. Its Agent may already have changed files, so it is not started again unless the Workflow allows more than one attempt (`max-attempts`, at most 10); then it is queued again as a new run with the next attempt number, until it has started that often.

```sh
pero runs            # the latest runs
pero runs show 7     # how run 7 ended, the history it read, and whom it notified
pero runs retry 7    # run a failed, interrupted, or cancelled run 7 again
pero runs cancel 7   # cancel run 7
```

`pero runs cancel <id>` cancels a run: one waiting to start never does, and a running one has its Agent's turn stopped. `pero runs retry <id>` queues a failed, interrupted, or cancelled run again as a new run with the next attempt, whatever `max-attempts` allows, reading the same Channel history.

### Reading chat history

A Workflow can read Channel history as its input, so an Agent can review your chats on a schedule. With `history: true`, each run puts a transcript of what people wrote in every Channel since the previous successful run (the last 24 hours for the first) in place of `{{history}}` in its input, or after the input. The next run starts where that one ended, so each message is read once, and a retry reads the same messages as the run it retries. `history-channels` reads only the topics it names, `history-messages: all` adds the Agents' replies, and `history-hours` reads a fixed window instead. A run with no messages to read completes without its Agent unless `run-when-empty: true` is set. The longest transcripts keep their newest messages and say how many older ones they left out.

```markdown
---
hour: 21
agent: english-coach
history: true
channel: English
---
Suggest better English for: {{history}}
```

### Notifications

Each topic a Workflow's `channel` names gets a Notification of each run that finishes, holding the Agent's answer under the Workflow's title, or why the run failed; an interrupted run that is retried leaves none, and its retry does. Cancelled runs and runs skipped for an empty history window notify no one. `channel` names a topic by its title, `<chat title>/<topic title>` when allowed groups share it, `General` for a group's General topic, or a Channel ID from `pero channels` for a direct chat. A title must be one Pero has seen in an allowed chat: until then the note has an error, which `pero status` and `pero check` report.

Notifications are recorded together with the run's final status and delivered to the Channel within seconds. While Telegram can't be reached, delivery retries with a growing wait for about a day before the Notification is marked failed. A Notification to a chat that is no longer allowed fails at once. A delivered Notification joins the Channel's history as a `workflow` message, and the next message you send there reaches the Agent with it, so you can reply to it: ask about a suggestion right where it was posted.

```sh
pero notifications --status failed   # Notifications that could not be delivered
pero notifications show 4            # its message, and what stands in the way of its delivery
pero notifications retry 4           # deliver Notification 4 now, or again with fresh attempts
```
