# Configuration reference

> **Status: proposal.** Part of [Pero configured by files](./README.md).

Pero reads four kinds of configuration:

| File | What it configures | Who may change it |
|---|---|---|
| [`.env`](#env) | Secrets | You, on the host |
| [`.pero/config.yaml`](#peroconfigyaml) | Where things are, which chats are allowed | You, on the host, or `pero telegram allow` |
| [`Settings/Pero.md`](#settingsperomd) | Defaults and shared instructions | You, from anywhere the vault syncs to |
| [`Settings/Agents/*.md`](#agent-notes), [`Settings/Workflows/*.md`](#workflow-notes) | Agents and Workflows | You, from anywhere the vault syncs to |

## Conventions

- **Notes are Markdown with YAML frontmatter,** as Obsidian writes them. The frontmatter is the block between `---` lines at the very top, and everything after it is the body. A note without frontmatter is valid: every property takes its default.
- **Property names are lowercase words joined by hyphens,** like `claude-model`. Unknown properties are errors, so a typo like `modle:` doesn't pass silently. Obsidian's own properties are allowed and ignored: `tags`, `aliases`, and `cssclasses`.
- **An empty property is not set.** A property Obsidian shows without a value takes its default.
- **The file name is the identity.** `Settings/Agents/Weekly Health.md` is the Agent titled *Weekly Health* and named `weekly-health`. The name is a slug made the same way Pero makes topic names today: lowercase, accents dropped, Cyrillic spelled in Latin letters. Two notes with the same name are an error. Renaming a note makes a new Agent or Workflow (see [Runtime](./RUNTIME.md#identity-and-renames)).
- **Subfolders are allowed** under `Agents/` and `Workflows/` for your own grouping. They don't change the name.
- **Ignored files:** names starting with `_` or `.`, and anything that isn't `.md`. That leaves room for templates and drafts, such as `_Template.md` and `_Ideas.md`.
- **Lists can be written either way:** `topics: Health` and `topics: [Health]` mean the same. Obsidian gives each property name one type across the vault, so it's best to keep `topics`, `channel`, and `day` as the List type everywhere.
- **Paths:** `~` is your home directory. A relative path is relative to the **workspace** (the folder containing `.pero/`), not to the note, so a cloned workspace keeps working wherever it's cloned.

## `.env`

Secrets, in the workspace root, next to `.pero/`:

```sh
PERO_TELEGRAM_BOT_TOKEN=123456:ABC-DEF…
```

- **Format:** one `KEY=value` per line; `#` starts a comment. The same file works as a systemd `EnvironmentFile=`.
- **Never committed.** `pero init` and `pero run` add `.env` to the workspace's `.gitignore` when it isn't there yet. `pero check` and `pero status` report an error when the workspace is in a Git repository that tracks `.env` or wouldn't ignore it (`git check-ignore`).
- **Must be owner-only.** Pero refuses to read it when it is readable by group or others, and says which `chmod` fixes that, as `ssh` does for keys.
- **Written for you:** an interactive `pero run` asks for a missing token and writes this file itself (mode `0600`), keeping any other lines in it.
- **Environment wins:** a variable already in Pero's environment overrides the file.
- **Only Pero's own secrets.** Claude and Codex sign-ins stay where their CLIs keep them (`~/.claude`, `~/.codex`).

Each workspace has its own `.env`, so two workspaces on one account can run two bots.

## `.pero/config.yaml`

Host settings: things that describe this installation and that an Agent working in the data folder must not be able to change.

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

- **Hand edits and `pero telegram allow`/`deny` are equivalent.** The commands edit this file and keep comments and ordering. Pero rereads the file within 10 seconds either way.
- **Chat ID changes:** when turning on topics gives a group a new chat ID, Pero rewrites that entry itself. This is one of the few writes Pero makes to configuration (see [Runtime](./RUNTIME.md#what-pero-writes)).
- **Changing `data` or `settings` needs a restart.** An error there, such as a folder that doesn't exist, stops startup with a message naming the key. Every other setting applies while Pero runs.

## `Settings/Pero.md`

Installation defaults. Each value applies to every Agent and Workflow that doesn't set its own, and applies **live**: changing `claude-model` here changes every Claude Agent without its own `model` from the next turn. Today these defaults only prefill new Agents.

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
| `permissions` | `ask`, `bypass` | `ask` | How Agents' tools are approved ([user guide](../USER_GUIDE.md#claude-agents)) |
| `timezone` | IANA zone | the host's | Time zone for schedules and transcripts |
| `main-agent` | Agent note name | `Main` | Answers the General topic, groups without topics, and direct chats |
| `new-topics` | `create-agent`, `main-agent` | `create-agent` | What a topic no Agent claims gets: a new Agent note, or the main Agent |
| `history-carryover` | 0 or more | 50 | Messages a fresh Session starts with; 0 turns it off |
| `history-retention-days` | whole days, or empty | empty: keep everything | Delete message history older than this |
| `max-concurrent-runs` | 1–10 | 2 | Workflow runs at once |

A missing `Pero.md` means all defaults.

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
| `enabled` | `true`, `false` | `true` | `false` silences it in its topics and stops its Workflows |

**The main Agent** is the note `main-agent` names (`Main.md` by default). It answers the General topic of every allowed group, groups without topics, and direct chats. It may also list `topics`.

**Which Agent answers a topic:** the Agent whose `topics` contains the topic's title. When two Agents claim the same title, neither answers there. Pero reports the conflict in the topic and in `pero check`. A topic no Agent claims is handled by `new-topics`:

- `create-agent`: Pero writes `Agents/<Topic title>.md` with `topics: [<Topic title>]`, starting from `Agents/_Template.md` when it exists (its properties and body, with `topics` set), and posts a welcome. That Agent answers from the first message.
- `main-agent`: the main Agent answers, in a Session of its own for that topic.

**Renaming a topic** in Telegram makes Pero change that title in the `topics` of the Agent that claimed it, so the topic keeps its Agent.

## Workflow notes

`Settings/Workflows/<Title>.md`. The body is the input each run sends to the Agent. It is sent as written, headings included. `{{history}}` in it is replaced by the chat transcript when the Workflow reads history.

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

| Property | Values | Default | Meaning |
|---|---|---|---|
| `trigger` | `schedule`, `manual` | `schedule` when a time is given, else `manual` | `manual` runs only by hand |
| `day` | `monday`…`sunday`, `daily`, `weekdays`, `weekends`, or a list of weekdays | `daily` | Days it runs |
| `hour` | 0–23, or a list | required for `schedule` unless `cron` is given | Hours it runs |
| `minute` | 0–59 | 0 | Minute of those hours |
| `cron` | five-field cron, or `@daily` etc. | none | For anything `day`/`hour`/`minute` can't say; replaces them |
| `timezone` | IANA zone | `Pero.md` `timezone` | Time zone of the schedule |
| `channel` | topic title, or a list | none | Where each run's answer is posted |
| `agent` | Agent note name | the Agent of the first `channel`, else the main Agent | Which Agent runs it |
| `history` | `true`, `false` | `false` | Read chat history as input ([user guide](../USER_GUIDE.md#reading-chat-history)) |
| `history-channels` | topic titles | all | Only these topics' history |
| `history-messages` | `people`, `all` | `people` | `all` adds the Agents' replies |
| `history-hours` | 1–720 | since the last successful run | A fixed window instead |
| `run-when-empty` | `true`, `false` | `false` | Run even when the window has no messages |
| `max-attempts` | 1–10 | 1 | Times a run may start, counting restarts after Pero stopped mid-run |
| `enabled` | `true`, `false` | `true` | `false` stops its schedule; it can still be run by hand |

Any Workflow can be run by hand with `pero workflows run <name>`, whatever its `trigger`.

**Schedules:** `day: sunday`, `hour: 12`, `minute: 0` is `0 12 * * 0`. `day: weekdays` and `hour: [9, 18]` is `0 9,18 * * 1-5`. Times the clocks skip or repeat follow the same daylight-saving rules as today ([Architecture §8](../ARCHITECTURE.md#8-scheduling-and-recovery)).

**Topic titles in `channel` and `history-channels`:**

- `General` means a group's General topic.
- A title must match a topic Pero has already seen. A topic it hasn't seen yet has no known address: write something in it first.
- When allowed groups share a title, write `<chat title>/<topic title>`, such as `Home/Health`. A title that matches several topics otherwise is an error.
- A Channel ID from `pero channels` (such as `5`) also works, for a direct chat or when titles don't help.

## Validation

`pero check` validates the whole workspace and exits 1 on any error. Errors name the file and property. It works with or without a running Pero:

- **With Pero running,** it asks the daemon, which also resolves topic titles against the topics it has seen.
- **Without Pero, or in CI on a workspace repository,** it reads the files itself and checks everything except whether topics exist.

```text
Settings/Workflows/Weekly health report.md
  channel: no topic titled "Helth"; seen topics: General, Health, English
Settings/Agents/Running.md
  topics: "Health" is also claimed by Settings/Agents/Health.md
Settings/Agents/Coach.md
  modle: unknown property (did you mean model?)
```
