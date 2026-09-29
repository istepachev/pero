# Runtime

> **Status: proposal.** Part of [Pero configured by files](./README.md). The rest of the design — the Channel adapter contract, the Session policy, run recovery, and Notification delivery — stays as described in [Architecture](../ARCHITECTURE.md). This page covers only what changes.

## Finding the workspace

Every `pero` command works on one workspace: the folder containing `.pero/`. It is found in this order:

1. `--workspace <dir>` (`-w`), on any command.
2. `PERO_WORKSPACE` in the environment.
3. The nearest folder containing `.pero/`, starting from the current folder and going up, the way Git finds a repository.
4. `~/workspace`, if it contains `.pero/`.

When none is found, the command says so and suggests `pero init`. `pero init [dir]` creates the skeleton: a `.gitignore` listing `.env` (or adds that line to an existing one), `.pero/config.yaml`, `.pero/.gitignore`, `data/Settings/Pero.md`, `data/Settings/Agents/Main.md`, `data/Settings/Agents/_Template.md`, and an empty `data/Settings/Workflows/`. It never overwrites an existing file, so running it in a cloned workspace only fills in what's missing.

One daemon runs per workspace, guarded by the lock in `.pero/run/` as today. The control socket goes in `.pero/run/` too. If the workspace path is too long for a Unix socket (about 100 bytes), the socket goes under `$XDG_RUNTIME_DIR` (or the system temp folder) instead, in a directory named after a hash of the workspace path.

## Loading and reloading

Pero holds the whole configuration in memory as one **snapshot**: `config.yaml`, `Pero.md`, every Agent, and every Workflow, with references resolved. Turns and runs read the snapshot current when they start, and keep it until they finish, as they keep an Agent's settings today.

**Every 10 seconds**, on the same tick that checks schedules, Pero:

1. **Scans** `config.yaml` and the settings folder recursively, keeping `.md` files whose names don't start with `_` or `.`.
2. **Compares** each file's size and modification time with the last scan, and rereads only the files that changed, appeared, or disappeared.
3. **Parses and validates** each changed file on its own: frontmatter, property types, values.
4. **Resolves references** across the whole set: `main-agent`, Workflow `agent` and `channel`, `topics` conflicts.
5. **Swaps in** the new snapshot at once, when anything changed, and logs which files changed.

A scan costs a directory listing and a `stat` per note, so a few hundred notes are no concern. Scanning is used instead of file-system events because it works the same on every OS, over network mounts, and for writes by Syncthing or `git pull`.

**Half-written files:** Obsidian saves in place, so a scan can catch a note mid-write. Pero reports a note as broken only when it fails in **two scans in a row** with the same size and modification time. Until then it keeps the previous version.

**Broken notes:** a note that doesn't parse or validate, or whose references don't resolve, is left out of the new snapshot. Its **last good version** stays in use while Pero runs, so a typo in a prompt's properties doesn't stop that Agent. After a restart, a note that is still broken is not loaded until it's fixed. Nothing else depends on it: other notes load normally.

**When edits take effect:** as today, and now for every edit:

| Change | Takes effect |
|---|---|
| Agent `provider` or `working-directory`, or the data folder an Agent follows | Its next turn in each topic, in a fresh Session that carries over recent messages |
| Agent instructions, `model`, `effort`, `permissions`, `Pero.md` body and defaults | Its next turn, in the same Session |
| Agent `topics` | The next message in the topics gained or lost |
| Agent removed or `enabled: false` | Its topics stop getting answers (see [Errors](#errors-and-health)); its Workflows stop |
| Workflow schedule (`day`, `hour`, `minute`, `cron`, `timezone`, `trigger`) | Its next run is computed from the time of the change; times already passed are not caught up |
| Workflow body or other properties | Its next run |
| Workflow removed or `enabled: false` | No more scheduled runs; a waiting run is cancelled, a running one finishes |
| `config.yaml` allowed chats | The next message from that chat |

## Identity and renames

An Agent or Workflow is identified by its **name**, the slug of its file name. SQLite rows that refer to one store that name, not a foreign key, so state survives notes coming and going:

- **Sessions** are keyed by Channel and Agent name.
- **Workflow runs** record the Workflow name and a snapshot of what they ran: the input, Agent, provider, options, and folder.
- **The history window** of a Workflow reading chats starts after the last completed run with that name.

**Renaming a note** is therefore a new identity. A renamed Agent starts fresh Sessions, which carry over each topic's recent messages, so the conversation continues. It keeps its topics, because it still claims them in `topics`. A renamed Workflow starts its history window 24 hours back, as a new Workflow does, and its schedule starts from the rename. The old name's runs stay in `pero runs`.

Moving a note to another subfolder keeps its name, so nothing changes.

## Routing messages to Agents

The Channel router works as today up to resolving the Channel, the topic Pero has seen, from SQLite. Choosing the Agent changes:

1. **A primary Channel** (the General topic, a group without topics, a direct chat) goes to the main Agent.
2. **A topic** goes to the Agent whose `topics` claims its title.
3. **An unclaimed topic** gets `new-topics`: Pero writes a new Agent note and answers with it, or the main Agent answers.

The route is computed from the snapshot for each message. It is not stored, so editing `topics` moves a topic to another Agent from its next message. Like a reassignment today, that closes the old Session, and the new Agent's first turn carries over the topic's recent messages.

The `channels` table keeps each topic's address and current title, so the router and Workflow `channel` references can match titles to addresses. It no longer stores an Agent.

## What SQLite keeps

SQLite is Pero's **state**: what Pero records while it runs, and what must survive a restart.

| Table | Change |
|---|---|
| `channels` | Kept: address and title. `agent_id` removed (routing comes from `topics`). `enabled` removed (disable the Agent instead). |
| `sessions` | Kept; `agent_id` becomes `agent_name`. |
| `messages` | Kept; `agent_id` becomes `agent_name`. |
| `workflow_runs` | Kept; `workflow_id` becomes `workflow_name`, and `trigger_id` goes. The execution snapshot also records the input it sent. |
| `notifications` | Kept, unchanged. |
| `inbound_updates` | Kept, unchanged. |
| `schedules` | **New.** One row per scheduled Workflow: `workflow_name`, a fingerprint of the schedule (cron and time zone), `next_run_at`, `last_run_at`. The fingerprint changes when the note's schedule does, and then `next_run_at` is computed afresh. |
| `settings`, `agents`, `workflows`, `triggers`, `workflow_notification_targets` | **Removed.** Now in notes. |
| `allowed_chats` | **Removed.** Now in `config.yaml`. |

Everything about recovery stays: runs still `running` at startup become `interrupted` and are retried per `max-attempts`. Missed schedule times coalesce into one catch-up run. Notifications retry with backoff. A catch-up run needs the note to still exist and be enabled when Pero starts; otherwise the schedule row is dropped.

## What Pero writes

Configuration is yours. Pero writes to it in exactly these cases, and logs each write:

| When | Writes |
|---|---|
| `pero init` | The skeleton files that don't exist yet |
| An interactive `pero run` gets a missing token | `.env`, and the `.env` line in `.gitignore` if it's missing |
| `pero telegram allow`/`deny` | The `allowed-chats` list in `config.yaml` |
| A group gets a new chat ID (topics turned on) | That entry's `id` in `config.yaml` |
| A topic no Agent claims, with `new-topics: create-agent` | A new `Agents/<Topic title>.md`. Characters not allowed in file names are replaced; an existing file is never overwritten |
| A claimed topic is renamed in Telegram | That title in the claiming Agent's `topics` |

Edits to existing files change only the one value, keeping comments, ordering, and the body. The note is rewritten atomically (write a temporary file, then rename it), so Obsidian and Syncthing never see half a note.

## Errors and health

A configuration problem is reported in four places:

- **`pero status`** gains a `config` component: `ok`, or `degraded — 2 notes have errors`.
- **`pero check`** lists every error with file and property ([Configuration](./CONFIGURATION.md#validation)).
- **The log** records each error once, when it appears, and again when it's fixed.
- **Telegram:** you'll often edit on your phone, so Pero posts one short message per broken version of a note: *"Weekly health report: channel: no topic titled 'Helth'. The last good version stays in use."* It goes to the topics the note relates to (an Agent's topics, a Workflow's `channel`), or to the main Agent's primary Channel. It isn't recorded in Channel history.

When a message arrives in a topic that can't be answered, Pero replies once saying why. For example, the Agent is disabled, two Agents claim the topic, or the Agent's note has never loaded. It doesn't queue the message for later.

## Security

**Agents can edit configuration.** An Agent works in the data folder by default, and the settings folder is inside it. That's deliberate, since "change your prompt to be less formal" should work. But an Agent could also change its own `permissions` or add a Workflow. So:

- **Claude Agents with `ask`:** a write under the settings folder always asks in the Channel, with Allow and Deny buttons, even though the Agent may otherwise edit its folder freely. Workflow runs have no one to ask, so they can't change configuration.
- **Codex Agents with `ask`:** the `workspace-write` sandbox allows writes anywhere in the folder and can't exclude a subfolder. A Codex Agent that must not touch configuration needs a `working-directory` that doesn't contain the settings folder.
- **`bypass` Agents** can change anything, as today.
- **Every applied change is logged** with the files that changed. When the workspace is a Git repository, `git diff` shows exactly what an Agent changed.

**Access control stays out of reach.** Allowed chats are in `.pero/config.yaml` and the token is in `.env`, both in the workspace root, outside the data folder. An Agent whose `working-directory` is the workspace root itself can read them, so give such an Agent `ask` permissions or another folder. An `ask` Agent working in the data folder can't grant a chat access without asking.

**Committed configuration is not secret.** Chat IDs, prompts, and schedules end up in Git. Keep that repository private. The token never goes there: `.env` is Git-ignored, and Pero reports it if Git would commit it.

## Backup and restore

```sh
pero backup ~/backups/pero.tgz     # while Pero runs
pero restore ~/backups/pero.tgz    # while Pero is stopped
```

- **A backup holds `.pero/`:** a consistent snapshot of the database from SQLite's online backup API, plus `config.yaml`.
- **Not in a backup:** the data folder and its settings (in your Git repository or sync), `.env` (write the token again on the new host), and logs.
- **`--include-data`** adds the data folder, for people who don't keep it anywhere else.
- **Restore** needs a workspace whose `.pero/` has no database yet. The usual path is: clone the workspace repository, `pero restore`, write the token, `pero run`.
