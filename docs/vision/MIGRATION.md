# Migration

> **Status: proposal.** Part of [Pero configured by files](./README.md). This covers the CLI after the change, how an existing installation moves over, and the questions still open.

## The CLI after the change

The CLI keeps what files can't do (start, stop, inspect, run by hand, back up) and drops what files do better.

| Command | Status |
|---|---|
| `pero init [dir]` | **New.** Creates a workspace skeleton; fills in only what's missing. |
| `pero check` | **New.** Validates the workspace; exit 1 on errors. Works without Pero running. |
| `pero run`, `run --foreground`, `stop`, `status`, `logs` | Kept. `status` gains the `config` and `settings` components. |
| `pero backup`, `restore` | Kept. They back up `.pero/`; `--include-data` adds the data folder. |
| `pero agents ls`, `agents show <name>` | Kept, read-only. They show each Agent's note path, effective values (and which come from `Pero.md`), and its topics. |
| `pero workflows ls`, `workflows show <name>` | Kept, read-only. They show the note path, the schedule as cron, the next run, and the resolved Channels. |
| `pero workflows run <name>` | Kept. Works for any Workflow, with no manual Trigger needed. |
| `pero channels ls`, `show`, `history` | Kept, read-only. `ls` shows the Agent each topic routes to now. |
| `pero telegram chats`, `allow`, `deny` | Kept. `allow`/`deny` edit `config.yaml`, and work without Pero running. |
| `pero runs …`, `pero notifications …` | Kept, unchanged. |
| `pero settings show` | Kept, read-only: effective values from `config.yaml` and `Pero.md`, and where the token comes from. |
| `pero settings set`/`unset` | **Removed.** Edit `Pero.md`, `config.yaml`, or `.env`. |
| `pero agents create`/`edit`/`enable`/`disable` | **Removed.** Edit or add an Agent note. |
| `pero workflows create`/`edit`/`enable`/`disable`/`notify` | **Removed.** Edit or add a Workflow note. |
| `pero triggers …` | **Removed.** The schedule is in the Workflow note. |
| `pero channels assign`/`enable`/`disable` | **Removed.** Use `topics` in Agent notes; disable the Agent to silence a topic. |
| `--data-dir`, `PERO_HOME` | **Replaced** by `--workspace` and `PERO_WORKSPACE`. |

A removed command stays for one release as a stub that says what to edit instead. For example: *"Agents are configured in notes now: edit data/Settings/Agents/coach.md."*

## Moving an existing installation

`pero migrate <workspace>` converts an installation in `~/.pero` (or `--data-dir`) into a workspace. It runs with Pero stopped and changes nothing in `~/.pero`, so the old installation remains a fallback.

It does the following:

1. **Makes the workspace** with `pero init`. The data folder becomes the old `default-working-directory`, written to `config.yaml` as `data:`.
2. **Writes `Settings/Pero.md`** from the settings row. Shared instructions become the body.
3. **Writes one Agent note per Agent:** instructions as the body, and only the properties that differ from `Pero.md`. The title comes from the Agent's title, or its name. Each Channel assigned to the Agent adds its topic title to `topics`. When two Channels with the same title were assigned to different Agents, the command stops and lists them for you to rename one topic.
4. **Writes one Workflow note per Workflow.** The input becomes the body. A schedule Trigger becomes `day`/`hour`/`minute` when it maps cleanly, otherwise `cron`. Notification targets become `channel`. A Workflow with several schedule Triggers gets one note per Trigger (`<Title> 1.md`, `<Title> 2.md`), and the command says so.
5. **Writes `allowed-chats`** into `config.yaml`, and the token into the workspace's `.env`.
6. **Copies the database** into `.pero/` and migrates it to the new schema: IDs become names, definition tables are dropped, and `schedules` rows get the Triggers' `next_run_at` so no run is missed or repeated. Disabled Agents and Workflows become notes with `enabled: false`, so their history keeps its names.
7. **Runs `pero check`** and prints the result.

Disabled Channels have no equivalent. Their topics go to whichever Agent claims them, and the command lists them.

## Implementation plan

The PR-by-PR plan, with acceptance criteria, is in [Implementation plan](./IMPLEMENTATION_PLAN.md).

## Open questions

1. **New topics:** is `create-agent` the right default, or should an unclaimed topic go to the main Agent until you write a note for it? Creating notes is today's behavior. Answering with the main Agent means Pero never writes to the vault unasked.
2. **Last good versions across restarts:** should Pero remember the last good version of a broken note in SQLite, so a restart doesn't drop it? That's more resilient, but it's the kind of hidden copy this design avoids.
3. **Codex and configuration writes:** is a separate `working-directory` enough protection for Codex `ask` Agents, or should Pero check for changes under the settings folder after each Codex turn and report them in the Channel?
4. **Topic identity:** titles make a workspace portable. But a topic renamed while Pero is stopped loses its Agent, because Pero never sees the rename. Is also accepting the topic's ID in `topics` (`topics: [Health, "-1001234567890:42"]`) worth the extra syntax?
5. **Workflows with several schedules:** is one note per schedule acceptable, or should `cron` (and `hour`/`day`) accept several independent schedules?
