# Pero configured by files

> **Status: proposal.** This describes where Pero is going, not how it works today. The current design, with every definition in SQLite and changed through the CLI, is in [Architecture](../ARCHITECTURE.md). [Migration](./MIGRATION.md) explains how we get from one to the other.

## Why

Setting Pero up today takes a sequence of CLI commands: create Agents, create Workflows, add Triggers, assign Channels, point notifications at Channel IDs. The result lives in a SQLite file where you can't read it, diff it, or copy it to another server. Changing a prompt means passing it through `pero agents edit --instructions -`.

Most of that is configuration that people want to **write**, not issue commands for: a prompt, a schedule, which topic a report goes to. Pero's users already keep their notes in Markdown, often an Obsidian vault. So configuration becomes Markdown notes in that vault:

- **The note body is the prompt.** An Agent's note holds its instructions. A Workflow's note holds what each run asks.
- **Properties are the settings.** Provider, model, schedule and topic go in the note's frontmatter, which Obsidian shows as editable properties on desktop and phone.
- **Git is the backup and the template.** A workspace is a folder that can be a Git repository. Clone it on a new server, add the Telegram token, run `pero run`, and it works.
- **SQLite keeps state, not configuration.** Conversations, message history, run records, and delivery queues stay in SQLite, because they change constantly and nobody edits them by hand. SQLite no longer holds definitions.

## Principles

1. **Files are the source of truth for configuration.** If it's not in a file, it's not configured. Pero never keeps a second copy of a definition that could drift from the file.
2. **Edit anywhere, applied within seconds.** Pero rescans the settings folder every 10 seconds. Changes arrive through Obsidian, Syncthing, `git pull`, or an Agent editing a note, and all apply the same way.
3. **A broken note never takes Pero down.** Pero skips a note that doesn't parse or validate, reports it, and keeps running everything else.
4. **Secrets are never committed.** The Telegram bot token lives in the workspace's `.env`, which is always Git-ignored, so you can commit and share everything else.
5. **What an Agent must not change lives outside its folder.** Agents edit notes in the data folder, so Pero keeps access control (which chats may talk to Pero) out of it.
6. **Few commands.** The CLI starts, stops, inspects, and checks. It no longer creates or edits definitions: you edit files for that.

## Layout

```text
~/workspace/                         # the workspace: where Pero runs; can be a Git repository
├── .env                             # secrets, owner-only, Git-ignored: PERO_TELEGRAM_BOT_TOKEN=…
├── .gitignore                       # Pero makes sure it lists .env
├── .pero/                           # Pero's own files
│   ├── config.yaml                  # host settings: data folder, allowed chats  (commit it)
│   ├── .gitignore                   # written by Pero: ignores everything below
│   ├── pero.sqlite                  # state: sessions, history, runs, notifications
│   ├── logs/
│   └── run/
├── data/                            # the data folder, such as an Obsidian vault
│   ├── Settings/
│   │   ├── Pero.md                  # installation defaults; its body is the shared instructions
│   │   ├── Agents/
│   │   │   ├── Main.md              # the main Agent: General topic and direct chat
│   │   │   ├── Health.md            # answers in the "Health" topic
│   │   │   └── _Template.md         # starting point for Agents of new topics (ignored as an Agent)
│   │   └── Workflows/
│   │       ├── Weekly health report.md
│   │       └── Evening English review.md
│   ├── Reports/                     # whatever the Agents and you write
│   └── …
└── projects/                        # optional: other folders Agents can work in
    └── site/
```

| Location | Holds | In Git | In `pero backup` |
|---|---|---|---|
| `.env` | The Telegram bot token | Never | Never |
| `.pero/config.yaml` | Where the data folder is, which chats are allowed | Yes | Yes |
| `.pero/pero.sqlite` | Sessions, message history, runs, notifications, schedule state | No | Yes |
| `data/Settings/` | Defaults, Agents, Workflows | Yes | No (it's in Git or synced) |
| `data/` (the rest) | Your notes and the Agents' work | Your choice | No |

The data folder is `data/` by default. `.pero/config.yaml` can point it elsewhere, such as an existing vault (`data: ~/notes`). Every Agent works in the data folder unless its note names another folder.

## A workspace in five notes

`data/Settings/Pero.md`:

```markdown
---
provider: claude
claude-model: opus
permissions: ask
timezone: Europe/Berlin
---
You are a calm, concise personal assistant. Reply in the language you're written to in.
```

`data/Settings/Agents/Main.md`, which needs no properties at all:

```markdown
You help with everyday questions and keep my notes tidy.
```

`data/Settings/Agents/Health.md`:

```markdown
---
topics: [Health]
effort: high
---
You are my health coach. My training log is in Health/Log.md.
```

`data/Settings/Workflows/Weekly health report.md`:

```markdown
---
trigger: schedule
day: sunday
hour: 12
minute: 0
channel: Health
---
# Workflow Instruction
Create a weekly report in the Reports directory from Health/Log.md…
```

`.pero/config.yaml`:

```yaml
data: data
telegram:
  allowed-chats:
    - id: -1001234567890
      title: Home
```

What happens:

- A message in the **Health** topic is answered by the Health Agent, with Pero's shared instructions and its own.
- Every **Sunday at 12:00** Berlin time, the Health Agent runs the weekly report and posts the result in **Health**.
- Creating a new topic, **Finance**, makes Pero write `Agents/Finance.md` from `_Template.md`. You edit its prompt in Obsidian, and the next message uses it.

## Clone and run

```sh
git clone git@github.com:me/my-pero.git ~/workspace
cd ~/workspace
pero run
```

`pero run` finds the workspace from the current folder and loads the notes. Then it asks for what's missing. The Telegram token goes to `.env` in the workspace. It also asks you to run `claude auth login` or `codex login` if the providers in use aren't signed in. Because the allowed chats are in the committed `config.yaml`, the same group keeps working on the new server.

To start fresh instead:

```sh
pero init ~/workspace   # writes .gitignore, .pero/config.yaml, Settings/Pero.md, Agents/Main.md, Agents/_Template.md
cd ~/workspace && pero run
```

## Read next

- [Configuration reference](./CONFIGURATION.md): every file and property.
- [Runtime](./RUNTIME.md): how Pero finds, loads, and reloads files, what SQLite still keeps, errors, and security.
- [Migration](./MIGRATION.md): the CLI after the change, and moving an existing installation.
- [Implementation plan](./IMPLEMENTATION_PLAN.md): phases 5–10, split into PRs with acceptance criteria.
