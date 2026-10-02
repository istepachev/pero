# Pero guide for Agents

Pero runs you. It is a self-hosted service that answers its owner in Telegram through Agents, and runs Workflows: tasks an Agent does on its own, on a schedule or on demand. Pero writes this guide on every start, so it matches the running version; don't edit it.

Read it when the owner asks you to create or change an Agent, a Workflow, or Pero's defaults, or asks how Pero works. Your instructions name the files below with their full paths: your own note, `Pero.md`, the `Workflows/` folder, and this guide.

## Where everything is

```text
<workspace>/                    # where Pero and its Agents run
├── .env                        # the Telegram bot token: never read it aloud, never edit it
├── .pero/                      # Pero's own files: don't edit them
│   ├── config.yaml             # the data folder, and which chats Pero serves
│   └── guide.md                # this guide
└── data/                       # the data folder: the owner's notes, such as an Obsidian vault
    └── System/               # the system folder
        ├── Pero.md             # installation defaults, settings only
        ├── Agents/<Title>.md   # one note per Agent; its body is that Agent's instructions
        └── Workflows/<Title>.md  # one note per Workflow; its body is what each run asks
```

The data folder and system folder can be elsewhere: your instructions give their real paths.

- **Notes are Markdown with YAML frontmatter,** the block between `---` lines at the top. The body is everything after it. Property names are lowercase and hyphenated. An unknown property is an error; `tags`, `aliases`, and `cssclasses` are allowed and ignored.
- **The file name is the identity.** `Agents/Weekly Health.md` is the Agent titled *Weekly Health*, named `weekly-health`. Renaming a note makes a new Agent or Workflow, so don't rename to "fix" a title unless asked. Subfolders under `Agents/` and `Workflows/` are fine for grouping.
- **Files starting with `_` or `.` are ignored,** such as `Agents/_Template.md`, the template for Agents of new topics.
- **Pero reads only `Pero.md`, `Agents/`, and `Workflows/`.** Other folders and files in the system folder are the owner's, such as `Templates/`; a note elsewhere, even in a misspelled `Agent/`, is not an Agent or Workflow.
- **Paths in notes** are relative to the workspace, not to the note. `~` is the home folder.
- **Pero rereads the system folder every 10 seconds.** An edit applies from the next message or run; no restart is needed.

## How to change settings

1. **Find out what the owner wants,** and ask about what you can't infer (see the checklists below). Don't invent schedules, topics, or models.
2. **Read the note first** when changing one, and change only the properties asked for. Keep comments, other properties, and the body.
3. **Say what you'll write before you write it,** with the file path and the frontmatter, unless the request was already exact.
4. **Write the note.** A Claude Agent with `permissions: ask` gets the owner's Allow or Deny, in the chat, before any edit in the system folder; that's expected. A Workflow run has no one to ask, so it can't change settings. A Codex Agent with `ask` can write only inside its own folder.
5. **Check it.** Pero posts an "Errors in …" message in the chat when a note doesn't validate, and keeps the note's last good version meanwhile. You can run `pero check` to validate everything (it may ask the owner first). Tell the owner what changed, and how to see it, such as `pero workflows show <name>`.

Never edit `.env` or anything in `.pero/`, and never add allowed chats: only the owner can, on the host, with `pero telegram allow`.

### Creating a Workflow

Agree on these before writing `Workflows/<Title>.md`:

- **Title:** the file name. Short, as it'll show in `pero workflows`, such as `Evening review`.
- **What each run does:** the note's body, sent as the run's input. It can't be empty. Write it as a complete request to an Agent who sees nothing else: name the files to read and write, and the shape of the answer. The answer is what gets posted.
- **When:** days, hours, and minute, or `cron`, and the time zone if it differs from `Pero.md`'s `timezone`. Without any, it runs only by hand.
- **Where the answer goes:** `channel`, a topic title or a list of them. Without it, the run's answer is only kept in `pero runs`.
- **Which Agent runs it:** `agent`, an Agent note's name. Without it, the Agent answering the first `channel` runs it, else the main Agent. The Agent's instructions, model, and folder apply.
- **Chat history,** only if it should review conversations: `history: true`, and `{{history}}` in the body where the transcript goes.

A run starts a fresh conversation, apart from the chat. Its Agent can't ask the owner anything: with `permissions: ask`, tools that would need approval, such as shell commands, web fetches, and settings edits, are refused. Say so if the task needs them; `permissions: bypass` for that Agent lifts this, but suggest it only if the owner wants it.

### Creating or changing an Agent

- **Topics:** one topic, one Agent. A Telegram topic belongs to the Agent whose `topic` is its title; the main Agent answers General topics and direct chats and has no `topic`. A new topic nobody claims gets an Agent note written by Pero, so the usual way to add an Agent is for the owner to create a topic and then edit its note.
- **Instructions:** the note's body. Every other Agent's instructions start with the main Agent's body, then its own. When the owner says "remember that my log is in Health/Log.md", that's an edit of your own note's body; a change meant for every Agent, such as "be less formal everywhere", is an edit of the main Agent's note.
- **Settings the owner may ask about:** `model`, `effort`, `provider`, `permissions`, `working-directory`, `enabled`.

## Properties

### `Pero.md`

| Property | Values | Default | Meaning |
|---|---|---|---|
| `provider` | `claude`, `codex` | `claude` | Provider of Agents that don't name one |
| `claude-model`, `codex-model` | model name | provider's default | Model for that provider's Agents |
| `claude-effort`, `codex-effort` | that provider's levels | provider's default | Effort for that provider's Agents |
| `permissions` | `ask`, `bypass` | `ask` | How Agents' tools are approved |
| `timezone` | IANA zone, such as `Europe/Berlin` | the host's | Time zone for schedules |
| `main-agent` | Agent note name | `Main` | Answers General topics, groups without topics, and direct chats |
| `history-carryover` | 0 or more | 50 | Messages a fresh conversation starts with |
| `history-retention-days` | whole days, or empty | keep everything | Delete older message history |
| `max-concurrent-runs` | 1–10 | 2 | Workflow runs at once |

It holds settings only: text after its frontmatter is an error. Changing a default changes every Agent that doesn't set its own value.

### Agent notes

| Property | Values | Default | Meaning |
|---|---|---|---|
| `topic` | one topic title | none | The Telegram topic it answers in, matched ignoring case; not for the main Agent |
| `provider` | `claude`, `codex` | `Pero.md` | Which provider runs it |
| `model` | model name | `Pero.md` `<provider>-model` | Its model |
| `effort` | provider's levels | `Pero.md` `<provider>-effort` | Its effort |
| `permissions` | `ask`, `bypass` | `Pero.md` | How its tools are approved |
| `working-directory` | path | the workspace | The folder it works in |
| `skip-main-instructions` | `true`, `false` | `false` | Leave the main Agent's instructions out of its own |
| `skip-git-repo-check` | `true`, `false` | `false` | Let a Codex Agent work outside a Git repository |
| `enabled` | `true`, `false` | `true` | `false` silences it and stops its Workflows' schedules |

Claude efforts are `low`, `medium`, `high`, `xhigh`, and `max`; Codex efforts are `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, and `persistent`. Changing `provider` or `working-directory` starts a fresh conversation that carries over the topic's recent messages; other changes keep it.

### Workflow notes

| Property | Values | Default | Meaning |
|---|---|---|---|
| `day` | `monday`…`sunday`, `daily`, `weekdays`, `weekends`, or a list of weekdays | `daily` | Days it runs |
| `hour` | 0–23, or a list | none: runs only by hand | Hours it runs |
| `minute` | 0–59 | 0 | Minute of those hours |
| `cron` | five-field cron, or `@daily` etc. | none | Instead of `day`/`hour`/`minute`, never with them |
| `timezone` | IANA zone | `Pero.md` `timezone` | Time zone of the schedule |
| `channel` | topic title, or a list | none | Where each run's answer is posted |
| `agent` | Agent note name | the first `channel`'s Agent, else the main Agent | Which Agent runs it |
| `history` | `true`, `false` | `false` | Read chat history as input |
| `history-channels` | topic titles | all | Only these topics' history |
| `history-messages` | `people`, `all` | `people` | `all` adds the Agents' replies |
| `history-hours` | 1–720 | since the last successful run | A fixed window instead |
| `run-when-empty` | `true`, `false` | `false` | Run even when there's no history to read |
| `max-attempts` | 1–10 | 1 | Times a run may start, counting restarts after Pero stopped mid-run |
| `enabled` | `true`, `false` | `true` | `false` stops its schedule; it can still run by hand |

One schedule per Workflow; for two different schedules, write two notes. Examples:

| Wanted | Properties |
|---|---|
| Every day at 21:00 | `hour: 21` |
| Weekdays at 9:00 and 18:00 | `day: weekdays`, `hour: [9, 18]` |
| Sundays at 12:30 | `day: sunday`, `hour: 12`, `minute: 30` |
| Monday and Thursday at 8:00 | `day: [monday, thursday]`, `hour: 8` |
| The 1st of each month at 10:00 | `cron: 0 10 1 * *` |
| Every 15 minutes | `cron: "*/15 * * * *"` (quoted: YAML can't start a value with `*`) |

A Workflow note:

```markdown
---
day: weekdays
hour: 8
minute: 30
channel: Health
---
Read Health/Log.md and post a short plan for today's workout, based on the last week.
```

### Topic titles

`channel`, `history-channels`, and `topic` name Telegram topics by title:

- `General` is a group's General topic, which the main Agent answers.
- A title in `channel` or `history-channels` must be a topic Pero has already seen a message in; until then the Workflow is left out and Pero reports it.
- When two allowed groups have topics with the same title, write `<chat title>/<topic title>`, such as `Home/Health`.
- A direct chat has no title: use its Channel ID from `pero channels`, such as `channel: 5`.

To post into the topic you're talking in, use your own `topic`, or `General` if you're the main Agent answering the General topic. When unsure, ask the owner which topic.

## How Pero works

- **Telegram:** Pero serves only the chats allowed in `.pero/config.yaml`. In a group with topics, each topic is one conversation with the Agent that claims it; the General topic, groups without topics, and direct chats go to the main Agent.
- **Conversations:** each topic keeps its conversation with its Agent across messages and restarts. Pero also records the chat's text, so a fresh conversation (after a provider or folder change) starts with the recent messages, and Workflows can read it.
- **Commands:** Pero answers these in the chat itself; you never see them or their answers. `/status` shows the topic's Agent, its note, its conversation and how full its context is, and Pero's health; `/new` starts the topic's conversation over, without the messages before it; `/stop` stops your answer in progress and drops the messages waiting for you; `/model` and `/effort` show your model or effort with buttons to change it in your note; `/workflows`, `/run`, `/runs`, `/cancel`, and `/retry` show, start, and manage Workflow runs; `/help` lists them. Point the owner to them when they fit, such as `/new` to start a fresh subject. Any other `/word` reaches you as text.
- **Permissions:** with `ask`, a Claude Agent reads and edits in its folder freely, and asks in the chat (Allow and Deny buttons) before anything else, including any edit in the system folder. A Codex Agent with `ask` runs in a sandbox that writes only in its folder, without network, and is never asked. `bypass` runs every tool without asking.
- **Workflows:** a schedule queues a run within about 10 seconds of each time it comes due. Times missed while Pero was down become one catch-up run. A run's answer is posted to its `channel` topics; those messages become part of the topic's conversation, so the owner can reply to them.
- **Broken notes** never stop Pero: it keeps the last good version and reports the errors in the chat.

The owner manages Pero from the host's terminal:

| Command | What it does |
|---|---|
| `pero status` | Whether Pero runs, and the health of each part |
| `pero check` | Validate every note |
| `pero agents`, `pero agents show <name>` | Agents, and one Agent's values and where each comes from |
| `pero workflows`, `pero workflows show <name>` | Workflows with their next run, and one Workflow |
| `pero workflows run <name>` | Run a Workflow now |
| `pero runs`, `pero runs show <id>` | Recent runs, and how one ended |
| `pero channels` | Topics and chats, with their IDs and Agents |
| `pero settings` | The defaults in effect |
| `pero telegram allow <chat>` | Allow a chat |
| `pero logs -f` | Follow the log |

The full documentation is at https://github.com/perokit/pero/tree/main/docs.
