# Configuring Pero

Pero is configured by files in its workspace. Agents, Workflows, and the installation defaults are Markdown notes, which you can edit in Obsidian on your desktop or phone, commit to Git, and copy to another server. Pero's database keeps only state: conversations, message history, runs, and delivery queues.

| File | What it configures | Who changes it |
|---|---|---|
| [`.env`](#env) | The Telegram bot token | You, on the host |
| [`.pero/config.yaml`](#peroconfigyaml) | Where the data folder is, and which chats Pero serves | You, on the host, or `pero telegram allow`/`deny` |
| [`Settings/Pero.md`](#settingsperomd) | Defaults and shared instructions | You, from anywhere the vault syncs to |
| [`Settings/Agents/*.md`](#agent-notes), [`Settings/Workflows/*.md`](#workflow-notes) | Agents and Workflows | You, from anywhere the vault syncs to |

[`examples/workspace/`](../examples/workspace/) is a complete workspace to start from.

## The workspace

```text
~/workspace/                         # the workspace: where Pero runs; can be a Git repository
├── .env                             # secrets, owner-only, Git-ignored: PERO_TELEGRAM_BOT_TOKEN=…
├── .gitignore                       # Pero makes sure it lists .env
├── .pero/                           # Pero's own files
│   ├── config.yaml                  # host settings: data folder, allowed chats (commit it)
│   ├── .gitignore                   # written by Pero: ignores everything else in .pero/
│   ├── pero.sqlite                  # state: Sessions, history, runs, Notifications
│   ├── logs/
│   └── run/
├── data/                            # the data folder, such as an Obsidian vault
│   ├── Settings/                    # the settings folder
│   │   ├── Pero.md                  # installation defaults; its body is the shared instructions
│   │   ├── Agents/
│   │   │   ├── Main.md              # the main Agent: General topics and direct chats
│   │   │   ├── Health.md            # answers in the "Health" topic
│   │   │   └── _Template.md         # starting point for Agents of new topics (not an Agent itself)
│   │   └── Workflows/
│   │       ├── Weekly health report.md
│   │       └── Evening review.md
│   ├── Reports/                     # whatever the Agents and you write
│   └── …
└── projects/                        # optional: other folders Agents can work in
    └── site/
```

| Location | Holds | In Git | In `pero backup` |
|---|---|---|---|
| `.env` | The Telegram bot token | Never | Never |
| `.pero/config.yaml` | Where the data folder is, which chats are allowed | Yes | Yes |
| `.pero/pero.sqlite` | Sessions, message history, runs, Notifications, schedule state | No | Yes |
| `data/Settings/` | Defaults, Agents, Workflows | Yes | With `--include-data` |
| `data/` (the rest) | Your notes and the Agents' work | Your choice | With `--include-data` |

Every `pero` command works on one workspace, found in this order: `--workspace <dir>` (`-w`), then `PERO_WORKSPACE`, then the nearest folder holding `.pero/` from the current folder upward (never the home folder itself), then `~/workspace` when it holds `.pero/`. `pero init [dir]` makes one: a `.gitignore` listing `.env`, `.pero/` with its `.gitignore` and a commented `config.yaml`, and in the settings folder `Pero.md`, `Agents/Main.md`, `Agents/_Template.md`, and an empty `Workflows/`. It never overwrites a file, so running it in a cloned workspace only fills in what's missing.

To set Pero up on another server, clone the workspace and run it:

```sh
git clone git@github.com:me/my-pero.git ~/workspace
cd ~/workspace
pero run     # asks for the bot token and writes it to .env
```

The allowed chats are in the committed `config.yaml`, so the same group keeps working. [Operating Pero](./OPERATIONS.md#moving-to-a-fresh-machine) describes bringing the database along too.

## Conventions

- **Notes are Markdown with YAML frontmatter,** as Obsidian writes them. The frontmatter is the block between `---` lines at the very top, and everything after it is the body. A note without frontmatter is valid: every property takes its default.
- **Property names are lowercase words joined by hyphens,** like `claude-model`. Unknown properties are errors, so a typo like `modle:` doesn't pass silently. Obsidian's own properties are allowed and ignored: `tags`, `aliases`, and `cssclasses`.
- **An empty property is not set.** A property Obsidian shows without a value takes its default.
- **The file name is the identity.** `Settings/Agents/Weekly Health.md` is the Agent titled *Weekly Health* and named `weekly-health`. The name is a slug: lowercase, accents dropped, Cyrillic spelled in Latin letters. Two notes with the same name are an error. Renaming a note makes a new Agent or Workflow (see [Renaming notes](#renaming-notes)).
- **Subfolders are allowed** under `Agents/` and `Workflows/` for your own grouping. They don't change the name. Any other note in the settings folder is an error, so a note in a misspelled `Agent/` folder isn't silently skipped.
- **Ignored files:** names starting with `_` or `.`, and anything that isn't `.md`. That leaves room for templates and drafts, such as `_Template.md` and `_Ideas.md`.
- **Lists can be written either way:** `topics: Health` and `topics: [Health]` mean the same. Obsidian gives each property name one type across the vault, so it's best to keep `topics`, `channel`, and `day` as the List type everywhere.
- **Paths:** `~` is your home directory. A relative path is relative to the **workspace** (the folder containing `.pero/`), not to the note, so a cloned workspace keeps working wherever it's cloned.

## `.env`

Secrets, in the workspace root, next to `.pero/`:

```sh
PERO_TELEGRAM_BOT_TOKEN=123456:ABC-DEF…
```

- **Format:** one `KEY=value` per line; `#` starts a comment, and `export` and quotes are allowed. The same file works as a systemd `EnvironmentFile=`.
- **Never committed.** `pero init` and storing the token add `.env` to the workspace's `.gitignore` when it isn't there yet. `pero check` and `pero status` report an error when the workspace is in a Git repository that tracks `.env` or wouldn't ignore it.
- **Must be owner-only.** Pero refuses to read it when it is readable by group or others, and says which `chmod` fixes that, as `ssh` does for keys.
- **Written for you:** an interactive `pero run` asks for a missing token and writes this file itself (mode `0600`), keeping any other lines in it. So does `pero telegram token`.
- **Environment wins:** a variable already in Pero's environment overrides the file.
- **Only Pero's own secrets.** Claude and Codex sign-ins stay where their CLIs keep them (`~/.claude`, `~/.codex`).

Each workspace has its own `.env`, so two workspaces on one account can run two bots.

## `.pero/config.yaml`

Host settings: what describes this installation, and what an Agent working in the data folder must not be able to change.

```yaml
# Data folder: the vault Agents work in. Relative to the workspace. Default: data
data: data

# Settings folder. Relative to the workspace. Default: <data>/Settings
# settings: data/Settings

telegram:
  # The chats Pero serves. Anyone who can post in an allowed group reaches its Agents.
  allowed-chats:
    - id: -1001234567890   # a group; negative
      title: Home          # for you; Pero doesn't use it
    - id: 123456789        # a direct chat: your user ID
```

- **Hand edits and `pero telegram allow`/`deny` are equivalent.** The commands edit this file and keep comments and ordering, and work without Pero running. Pero rereads the file within 10 seconds either way: a chat added or removed is served, or turned away, from its next message.
- **Chat ID changes:** when turning on topics gives a group a new chat ID, Pero rewrites that entry itself.
- **Changing `data` or `settings` needs a restart.** Until then, `pero status` shows the `config` component `degraded` saying so. A folder that doesn't exist stops startup with a message naming the key.
- **An invalid file** stops startup with the file, line, key, and reason. An invalid edit while Pero runs is logged and shown by `pero status`, and the last valid version stays in use.

The data folder can be an existing vault anywhere, such as `data: ~/notes`. Every Agent works in it unless its note names another folder.

## `Settings/Pero.md`

Installation defaults. Each value applies to every Agent and Workflow that doesn't set its own, and applies **live**: changing `claude-model` here changes every Claude Agent without its own `model` from its next turn.

The body is the **shared instructions**, placed before each Agent's own (unless the Agent opts out).

```markdown
---
provider: claude
claude-model: opus
claude-effort: high
codex-model: gpt-5.5
permissions: ask
timezone: Europe/Berlin
main-agent: Main
new-topics: create-agent
history-carryover: 50
history-retention-days: 90
max-concurrent-runs: 2
---
You are a calm, concise personal assistant. Reply in the language you're written to in.
```

| Property | Values | Default | Meaning |
|---|---|---|---|
| `provider` | `claude`, `codex` | `claude` | Provider of Agents that don't name one |
| `claude-model`, `codex-model` | provider model name | provider's default | Model for that provider's Agents |
| `claude-effort`, `codex-effort` | that provider's levels | provider's default | Effort for that provider's Agents |
| `permissions` | `ask`, `bypass` | `ask` | How Agents' tools are approved ([user guide](./USER_GUIDE.md#claude-agents)) |
| `timezone` | IANA zone | the host's | Time zone for schedules and transcripts |
| `main-agent` | Agent note name | `Main` | Answers the General topic, groups without topics, and direct chats |
| `new-topics` | `create-agent`, `main-agent` | `create-agent` | What a topic no Agent claims gets: a new Agent note, or the main Agent |
| `history-carryover` | 0 or more | 50 | Messages a fresh Session starts with; 0 turns it off |
| `history-retention-days` | whole days, or empty | empty: keep everything | Delete message history older than this |
| `max-concurrent-runs` | 1–10 | 2 | Workflow runs at once |

A missing `Pero.md` means all defaults, as does a broken one that hasn't loaded since Pero started (see [Broken notes](#broken-notes)).

## Agent notes

`Settings/Agents/<Title>.md`. The body is the Agent's instructions.

```markdown
---
topics: [Health, Running]
provider: claude
model: sonnet
effort: high
permissions: ask
---
You are my health coach. My training log is in Health/Log.md; append each workout I tell you about.
```

| Property | Values | Default | Meaning |
|---|---|---|---|
| `topics` | list of topic titles | none | Telegram topics this Agent answers in, matched by title ignoring case |
| `provider` | `claude`, `codex` | `Pero.md` `provider` | Which provider runs it |
| `model` | model name | `Pero.md` `<provider>-model` | Model, for this Agent's provider |
| `effort` | provider's levels | `Pero.md` `<provider>-effort` | Effort, for this Agent's provider |
| `permissions` | `ask`, `bypass` | `Pero.md` `permissions` | How its tools are approved |
| `working-directory` | path | the data folder | The folder it works in, relative to the workspace (such as `projects/site`) |
| `shared-instructions` | `true`, `false` | `true` | Put `Pero.md`'s body before its own |
| `skip-git-repo-check` | `true`, `false` | `false` | Let a Codex Agent work outside a Git repository |
| `enabled` | `true`, `false` | `true` | `false` silences it in its topics and stops its Workflows' schedules |

**The main Agent** is the note `main-agent` names (`Main.md` by default). It answers the General topic of every allowed group, groups without topics, and direct chats, each in a Session of its own. It may also list `topics`. When its note is missing, Pero writes it the first time a General topic or direct chat needs it.

**Which Agent answers a topic:** the Agent whose `topics` contains the topic's title. When two Agents claim the same title, neither answers there, and Pero reports the conflict on both notes. A topic no Agent claims is handled by `new-topics`:

- `create-agent`: Pero writes `Agents/<Topic title>.md` with `topics: [<Topic title>]`, starting from `Agents/_Template.md` when it exists (its properties and body, with `topics` added), and posts a welcome. That Agent answers from the first message.
- `main-agent`: the main Agent answers, in a Session of its own for that topic.

The route is worked out again for every message, so editing `topics` moves a topic to another Agent from its next message. The new Agent's first turn starts a fresh Session that carries over the topic's recent messages.

**Renaming a topic** in Telegram makes Pero change that title in the `topics` of the Agent that claimed it, so the topic keeps its Agent. The old title stays too while another topic still has it. A topic renamed while Pero is stopped keeps its old title in the notes: change `topics` by hand.

## Workflow notes

`Settings/Workflows/<Title>.md`. The body is the input each run sends to the Agent, as written, headings included, and must not be empty. `{{history}}` in it is replaced by the chat transcript when the Workflow reads history.

```markdown
---
day: sunday
hour: 12
channel: Health
---
Create a weekly report in the Reports folder from Health/Log.md…
```

| Property | Values | Default | Meaning |
|---|---|---|---|
| `trigger` | `schedule`, `manual` | `schedule` when a time is given, else `manual` | `manual` runs only by hand, even with a time |
| `day` | `monday`…`sunday`, `daily`, `weekdays`, `weekends`, or a list of weekdays | `daily` | Days it runs |
| `hour` | 0–23, or a list | required for a schedule unless `cron` is given | Hours it runs |
| `minute` | 0–59 | 0 | Minute of those hours |
| `cron` | five-field cron, or `@daily` etc. | none | For anything `day`/`hour`/`minute` can't say; not together with them |
| `timezone` | IANA zone | `Pero.md` `timezone` | Time zone of the schedule |
| `channel` | topic title, or a list | none | Where each run's answer is posted |
| `agent` | Agent note name | the Agent of the first `channel`, else the main Agent | Which Agent runs it |
| `history` | `true`, `false` | `false` | Read chat history as input ([user guide](./USER_GUIDE.md#reading-chat-history)) |
| `history-channels` | topic titles | all | Only these topics' history |
| `history-messages` | `people`, `all` | `people` | `all` adds the Agents' replies |
| `history-hours` | 1–720 | since the last successful run | A fixed window instead |
| `run-when-empty` | `true`, `false` | `false` | Run even when the window has no messages |
| `max-attempts` | 1–10 | 1 | Times a run may start, counting restarts after Pero stopped mid-run |
| `enabled` | `true`, `false` | `true` | `false` stops its schedule; it can still be run by hand |

Any Workflow can be run by hand with `pero workflows run <name>`, whatever its `trigger`.

**Schedules:** `day: sunday`, `hour: 12`, `minute: 0` is `0 12 * * 0`. `day: weekdays` and `hour: [9, 18]` is `0 9,18 * * 1-5`. Times the clocks skip or repeat follow the daylight-saving rules in [Architecture §8](./ARCHITECTURE.md#8-scheduling-and-recovery).

**Topic titles in `channel` and `history-channels`:**

- `General` means a group's General topic.
- A title must match a topic Pero has already seen in an allowed chat. A topic it hasn't seen yet has no known address: write something in it first. Until then, the Workflow is left out, and `pero status` and `pero check` report it.
- When allowed groups share a title, write `<chat title>/<topic title>`, such as `Home/Health`. A title that matches several topics otherwise is an error.
- A Channel ID from `pero channels` (such as `5`) also works, for a direct chat or when titles don't help.

## Validation

`pero check` validates the whole workspace and exits 1 on any error, naming the file and property. It works with or without a running Pero:

- **With Pero running,** it asks the daemon, which also resolves topic titles against the topics it has seen.
- **Without Pero, or in CI on a workspace repository,** it reads the files itself and checks everything except whether topics exist.

```text
data/Settings/Workflows/Weekly health report.md
  channel: no topic titled "Helth"; seen topics: General, Health, English
data/Settings/Agents/Coach.md
  modle: unknown property (did you mean model?)

2 problems in 2 files.
```

`--json` prints the result for tools.

## How Pero reads the files

Pero holds the whole configuration in memory as one snapshot: `Pero.md`, every Agent, and every Workflow, with references resolved. A turn or run uses the snapshot current when it starts, until it finishes. **Every 10 seconds**, Pero rescans the settings folder, rereads only the notes whose size or modification time changed, and swaps in a new snapshot when anything did, logging which files changed. Edits arrive the same way whether you make them in Obsidian, through Syncthing or `git pull`, or an Agent makes them.

| Change | Takes effect |
|---|---|
| Agent `provider` or `working-directory`, or the data folder an Agent follows | Its next turn in each topic, in a fresh Session that carries over recent messages |
| Agent instructions, `model`, `effort`, `permissions`, `Pero.md` body and defaults | Its next turn, in the same Session |
| Agent `topics` | The next message in the topics gained or lost |
| Agent removed or `enabled: false` | Its topics stop getting answers; its Workflows' schedules pass without a run |
| Workflow schedule (`day`, `hour`, `minute`, `cron`, `timezone`, `trigger`) | Its next run is computed from the time of the change; times already passed are not caught up |
| Workflow body or other properties | Its next run |
| Workflow removed or `enabled: false` | No more scheduled runs; runs its schedule queued are cancelled (all its waiting runs, when removed), and a running one finishes |
| `config.yaml` allowed chats | The next message from that chat |

### Broken notes

A broken note never takes Pero down:

- **A note that doesn't parse or validate** is left out, along with only the notes that depend on it, such as a Workflow whose `agent` is broken. While Pero runs, its **last good version** stays in use, so a typo in a prompt's properties doesn't stop that Agent. After a restart, a note that is still broken isn't loaded until it's fixed.
- **A Workflow whose `channel` doesn't resolve,** such as a topic Pero hasn't seen, is left out until it does.
- **Half-written files** are not errors: Pero reports a note only when it fails twice in a row with the same size and modification time.

Problems are reported in four places:

- **`pero status`:** the `settings` component is `degraded`, counting the notes with errors.
- **`pero check`:** every error, with its file and property.
- **The log:** each error once, when it appears, and again when it's fixed.
- **Telegram:** since you'll often edit on your phone, Pero posts one message per broken version of a note, naming each error and what Pero uses meanwhile: *"Errors in data/Settings/Workflows/Weekly health report.md: channel: no topic titled "Helth"… It's left out until it's fixed."* It goes to the topics the note relates to (an Agent's `topics`, a Workflow's `channel`), or else to the main Agent's General topic or direct chat, and isn't part of the topic's history. A fix is only logged, and notes already broken when Pero starts are left to `status` and `check`.

When a message arrives in a topic no Agent can answer, because its Agent is disabled, two Agents claim it, or its note has never loaded, Pero replies once saying why.

### Renaming notes

State in the database names an Agent or Workflow by its name, so it outlives the note: Sessions are kept per Channel and Agent name, runs record the Workflow's name and what they ran, and a Workflow's history window starts after its last completed run of that name.

Renaming a note is therefore a new identity. A renamed Agent starts fresh Sessions, which carry over each topic's recent messages, so the conversation continues; it keeps its topics, because it still claims them in `topics`. A renamed Workflow starts its history window 24 hours back, as a new Workflow does, and its schedule starts from the rename. The old name's runs stay in `pero runs`. Moving a note to another subfolder keeps its name, so nothing changes.

### What Pero writes

Configuration is yours. Pero writes to it only in these cases, and logs each write:

| When | Writes |
|---|---|
| `pero init` | The skeleton files that don't exist yet |
| A token is stored (`pero run` asks for it, or `pero telegram token`) | `.env`, and the `.env` line in `.gitignore` if it's missing |
| `pero telegram allow`/`deny` | The `allowed-chats` list in `config.yaml` |
| A group gets a new chat ID (topics turned on) | That entry's `id` in `config.yaml` |
| A topic no Agent claims, with `new-topics: create-agent` | A new `Agents/<Topic title>.md`. Characters file names can't hold are replaced, and an existing file is never overwritten (`Health 2.md`) |
| A General topic or direct chat whose main Agent has no note | `Agents/Main.md`, or the note `main-agent` names |
| A claimed topic is renamed in Telegram | That title in the claiming Agent's `topics` |

Edits to existing files change only the one value, keeping comments, ordering, and the body. Every write is atomic, so Obsidian and Syncthing never see half a note.

## Security

**Agents can edit configuration.** An Agent works in the data folder by default, and the settings folder is inside it. That's deliberate, since "change your prompt to be less formal" should work. But an Agent could also change its own `permissions` or add a Workflow. So:

- **Claude Agents with `ask`:** an edit under the settings folder always asks in the Channel, with Allow and Deny buttons, even though the Agent may otherwise edit its folder freely. Workflow runs have no one to ask, so they can't change configuration.
- **Codex Agents with `ask`:** the `workspace-write` sandbox allows writes anywhere in the folder and can't leave out a subfolder. A Codex Agent that must not touch configuration needs a `working-directory` that doesn't contain the settings folder.
- **`bypass` Agents** can change anything.
- **Every applied change is logged** with the files that changed. When the workspace is a Git repository, `git diff` shows exactly what an Agent changed.

**Access control stays out of the data folder.** Allowed chats are in `.pero/config.yaml` and the token is in `.env`, both in the workspace root, outside the data folder. An Agent whose folder is the workspace root itself, such as with `data: .`, can read them and edit them as it edits the rest of its folder, whatever its permissions, so keep the data folder, and every Agent's `working-directory`, apart from the workspace root.

**Committed configuration is not secret.** Chat IDs, prompts, and schedules end up in Git, so keep that repository private. The token never goes there: `.env` is Git-ignored, and Pero reports it if Git would commit it.
