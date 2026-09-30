# Implementation plan: configured by files

> **Status: proposal.** Part of [Pero configured by files](./README.md). It continues the numbering of the [current implementation plan](../IMPLEMENTATION_PLAN.md), whose phases 1–4 built today's SQLite-configured Pero.

The same rules apply as in the current plan:

- **Each PR leaves `main` green:** building, linting, type-checking, and passing its tests.
- **Acceptance criteria describe behaviour,** not class layout.
- **A phase is done when its exit criteria hold,** not merely when its PRs have merged.

## Strategy

The switch touches almost every module that reads an Agent, a Workflow, or a setting. Thirteen services import the `Agent` entity alone. To keep PRs small, the work runs in this order:

1. **New layout first** (phase 5). Workspace, `.env`, and `config.yaml` replace the data directory and the pieces of SQLite that belong on the host. Behaviour stays the same otherwise.
2. **Loader next, used by nothing** (phase 6). The note parser, the snapshot, reloading, and `pero check` are built and tested on their own.
3. **Branch by abstraction** (phase 7). Every consumer reads definitions through one `Definitions` interface, still backed by SQLite. State tables switch from IDs to names. `pero migrate` writes an installation's definitions as notes.
4. **Switch one domain at a time** (phases 8 and 9). Agents, then Workflows, move from the SQLite-backed `Definitions` to the note-backed one. Each phase ends by dropping the tables it replaced.
5. **Ship** (phase 10). Example workspace, docs, release.

**Existing installations keep working until the release.** Until phase 10, a legacy data directory (`--data-dir`, `PERO_HOME`, or an existing `~/.pero` with no workspace found) still starts. From phase 8 on, it needs `pero migrate` first, and says so. The version that ships this is `0.2.0`. Removed commands become stubs that say what to edit instead, and a later release removes the stubs and the legacy data directory.

**What can run in parallel:** 5.x and 6.1–6.2 don't depend on each other. 6.3 and later need the workspace and `config.yaml` (5.1–5.3a), since they find the settings folder through them. Phase 7 needs 6.2. Phases 8 and 9 are sequential, since both change the `Definitions` implementation.

```text
5.1 ─ 5.2 ─ 5.3a ┬─ 5.3b ─ 5.4 ─ 5.5 ─┐
                 │                    │
6.1 ─ 6.1b ─ 6.2 ┴─ 6.3 ─ 6.4 ─ 6.3b ─┴─ 7.1a ─ 7.1b ─ 7.2 ─ 7.3 ─ 7.4 ─ 8.1 … 8.5 ─ 9.1 … 9.4 ─ 10.1 ─ 10.2 ─ 10.3
```

## Phase 5 — workspace

Replace the data directory with the workspace layout from the [overview](./README.md#layout): `.pero/` for state and host configuration, `.env` for the token, `config.yaml` for the data folder and allowed chats. Agents and Workflows still come from SQLite.

### 5.1 Workspace discovery and layout

Add workspace resolution to the bootstrap configuration (`src/config/bootstrap-config.ts`), tried in this order:

1. `--workspace`/`-w` on any command, or the legacy `--data-dir` (not both).
2. `PERO_WORKSPACE`, then the legacy `PERO_HOME`.
3. The nearest folder containing `.pero/`, from the current folder upward. The home folder itself never counts: its `.pero` is the legacy data directory.
4. `~/workspace` if it contains `.pero/`.
5. The legacy data directory `~/.pero`.

An explicit choice always wins over a workspace found from the current folder, and a workspace is identified by its real path, so a symlinked folder is the same workspace. The development scripts use the checkout as a workspace (`-w .`).

`dataDirLayout` knows the workspace: its state is `.pero/pero.sqlite`, `.pero/logs/`, `.pero/run/`, as in a data directory. Startup writes `.pero/.gitignore`, which ignores everything in `.pero/` except `config.yaml` and `.gitignore`. When the socket path would exceed the Unix limit, the socket moves to `$XDG_RUNTIME_DIR/pero-<hash>/` (or the temp folder), and commands find it through the process metadata.

`pero status` shows the workspace, or the data directory marked `(legacy)`.

**Done when:**
- Unit tests cover the precedence and the upward search, including a workspace inside a Git repository, a symlinked folder, and a symlinked home folder.
- A daemon started in a temporary workspace creates the layout and the `.gitignore`.
- A deep workspace path still gets a working socket.
- A legacy data directory starts as before.

### 5.2 `.env` credentials

Pero's secrets move to `<workspace>/.env` (`src/config/env-file.ts`):

- **Read:** a small dotenv parser (`KEY=value`, `export`, `#` comments, optional quotes). Reading is refused, with a `chmod 600` hint in the `telegram` component, when group or others can read the file. A variable in the environment wins.
- **Write:** `pero settings set telegram-bot-token` and the interactive `pero run` still go through the daemon, which writes the token atomically with mode `0600`, keeping other lines and comments.
- **`.gitignore`:** writing the token also makes sure the workspace `.gitignore` lists `.env`.
- **Git check:** when the workspace is in a Git repository, `pero status` reports an error if Git tracks `.env` or wouldn't ignore it (`git ls-files`, `git check-ignore`). The CLI runs the check itself, so it works whether or not Pero runs, and `pero check` can reuse it.
- **Legacy:** `secrets/telegram-bot-token` is still read and written, in a legacy data directory only. A workspace has no `secrets/`, and its backups carry no token.

`TelegramCredentials` changes accordingly; the token source `env-file` shows as `set (.env)`.

**Done when:**
- Tests cover parsing, precedence over the file, the permission refusal, and writing that keeps other lines and comments.
- The `.gitignore` line is added once.
- The Git check catches a tracked `.env`.
- The token never appears in logs, `status`, or `settings show`.

### 5.3a `config.yaml`: data folder and allowed chats

`config.yaml` lives in the state directory: `.pero/config.yaml` in a workspace, `<data dir>/config.yaml` in a legacy data directory, so both take one code path. `src/config/host-config.ts` parses it with `yaml` (YAML 1.2, integers as bigints so large chat IDs keep every digit) against a strict Zod schema for `data`, `settings`, and `telegram.allowed-chats`. Errors name the file, line, key, and reason. Writes go through the `yaml` document API: each one reads the file again, changes only its own lines, and replaces the file atomically, so comments, ordering, and hand edits survive.

- **`data`** replaces the `default-working-directory` setting. On first start, a missing `config.yaml` gets `data:` from that setting (relative to the workspace when inside it, absolute in a legacy data directory), or `data`. At every start the resolved folder is copied into the settings row, which the rest of Pero reads until 8.5 drops it. A workspace's `data/` is created when missing; any other missing folder stops startup in a workspace and only warns in a legacy data directory.
- **`telegram.allowed-chats`** replaces the `allowed_chats` table. At startup, any rows are added to the file (a union by chat ID) and then deleted, so the import happens once and a restored older database is picked up too. The table itself is dropped in 9.4. `AllowedChatsService` keeps its interface, backed by the file; chat kinds come from the ID's sign, and titles seen in messages stay in memory, so Pero writes the file only when the list changes.
- **`pero telegram allow`/`deny`** and `settings set default-working-directory` go through the daemon, which edits the file.
- **A chat ID migration** moves the Channel, then rewrites that entry's `id` (or drops it when the new ID is already allowed).
- **An invalid `config.yaml`** stops startup with the file, line, key, and reason.
- **Backups** (format 2) include `config.yaml`; format 1 backups still restore.

**Done when:**
- `allow`/`deny` keep comments.
- Chat migration updates the file.
- Existing `allowed_chats` rows and the default working directory are carried into a new `config.yaml` exactly once.

### 5.3b Live reload, and `allow`/`deny` without the daemon

- **The daemon rereads `config.yaml` every 10 seconds** (a size and mtime check; Pero's own writes don't count). A chat added or removed by hand applies from its next message, and the Telegram status catches up: the chat count, and the bot's standing in each group added.
- **`pero telegram allow`/`deny` edit the file directly** when Pero isn't running, without loading the daemon's dependencies, and say the change applies when Pero starts.
- **`data` and `settings` changes need a restart.** A new `config` component in `pero status` says so while the file differs from what Pero runs with. `settings set default-working-directory` still applies at once.
- **At runtime, an invalid edit** (or a deleted file) is logged once per version and shown by `config`, and the last valid version stays in use.

**Done when:**
- A chat allowed by hand is served from the next look, and one removed stops being served.
- `allow`/`deny` work without Pero running and keep comments.

### 5.4 `pero init` and first run

`pero init [dir]` (default: `--workspace`, then the current folder) writes the skeleton:

- `.gitignore` with `.env`, or the line added to an existing one
- `.pero/` with its `.gitignore`, and `.pero/config.yaml` with commented defaults
- in the settings folder (`data/Settings/` unless `config.yaml` names another data or settings folder): `Pero.md`, `Agents/Main.md`, and `Agents/_Template.md`, each with commented example properties that the phase 6 note readers accept
- an empty `Workflows/`

It never overwrites a file, and prints what it created, updated, and kept. It refuses the home folder and a legacy data directory. These notes aren't read until phase 8. They exist now so a workspace made today stays valid.

Discovery no longer creates `~/.pero`: it is used only when it exists. With no workspace found, an interactive `pero run` offers `pero init` in the current folder (or `~/workspace` from home). This replaces today's working-folder question, which a workspace no longer needs, since its `data/` folder is set. A non-interactive run prints the `pero init` command and exits 1; `pero status` exits 3 with the same hint.

**Done when:**
- Running `init` twice changes nothing the second time.
- `init` inside a cloned workspace fills in only missing files.
- An interactive first run from home ends with a running Pero in `~/workspace`.
- The packed-install job starts from `pero init ~/workspace`.

### 5.5 Backup and restore of a workspace

- **`pero backup`** archives the database snapshot and `config.yaml`, as before; a legacy data directory's backup still has its `secrets/`. `.env`, logs, and `run/` are never included, so a workspace's backup has no token.
- **`--include-data`** adds the data folder under `data/`: its regular files and folders, never links, and not `.pero/` or `.env` should they be inside it. The destination must be outside it. Only such a backup is format 3, with `includesData` in the manifest, so an older Pero restores every other backup and asks for an upgrade for this one. Staging moves next to the destination, which has room for it, instead of a temporary folder that may be in memory.
- **`pero restore <file>`** into a workspace (found, or `-w`, created when missing) needs a `.pero/` without `pero.sqlite*`. It extracts next to `.pero/` and copies each file without overwriting, the database first, so a daemon starting meanwhile stops it with nothing changed.
  - **`config.yaml`:** the workspace's own is kept, and the chats only the backup's allowed are listed; `--replace-config` takes the backup's. Nothing is said when both are the same.
  - **Data:** into the folder the workspace's `config.yaml` names, keeping each file already there, with the numbers copied and kept.
  - **Legacy backups:** their token goes to `.env` unless it has one, with the `.gitignore` line.
  - **Missing folders** are checked against the workspace's `config.yaml`, not the path the backup recorded; a legacy backup's default `data/` isn't reported, since it never had one.
- **Into a legacy data directory**, restore is unchanged, and refuses a backup with a data folder.
- **Found while building:** a workspace restored at another path keeps working, but each Channel starts a fresh Session with its recent messages, since a provider conversation belongs to its folder. The drill restores at the same path, as on a new machine.

**Done when:**
- A backup restores into a freshly cloned workspace, and Pero starts with the same history and runs: `test/restore.e2e-spec.ts`.
- `--include-data` round-trips the data folder: `test/restore.e2e-spec.ts`, `test/cli.e2e-spec.ts`.
- A legacy backup restores into a workspace, its token in `.env`: `test/cli.e2e-spec.ts`, the packed-install script.
- The packed-install CI job runs `init`, `run`, a Git commit check, `backup --include-data`, `stop`, and `restore` into a `git clone`, then a legacy backup restored into a data directory and a workspace.

### Phase 5 exit criteria

- `pero init ~/workspace && cd ~/workspace && pero run` sets up a working Pero with its state in `.pero/` and its token in `.env`.
- Committing the workspace commits `config.yaml` and nothing secret.
- Allowed chats can be changed by editing `config.yaml`.
- Backups restore into a cloned workspace.
- A legacy data directory still works unchanged.

## Phase 6 — settings loader

Build the note loader as a pure module, `src/settings-files/` (no Nest or TypeORM, like `src/config/`), and run it in the daemon. Nothing reads its snapshot yet.

Each problem is reported as `{ file, property, message }`: `file` is the note's path inside the settings folder, and `property` is null for a problem with the whole note.

### 6.1 Note parsing

Add the `yaml` dependency (5.3 needs it too).

- **Frontmatter:** only when the first line is `---`, up to the next `---` line. It's parsed with `yaml` as YAML 1.2, so `12:00` and `yes` stay strings. It must be `name: value` lines. A missing closing line, duplicate keys, and syntax errors are errors naming the line.
- **Body:** everything after the frontmatter, trimmed. An empty body counts as none.
- **Ignored files:** anything but `.md`, and any file or folder whose name starts with `_` or `.` (`_Template.md`, `.obsidian/`).
- **Kinds by location:** `Pero.md` at the root, Agents anywhere under `Agents/`, Workflows anywhere under `Workflows/`. Any other note in the settings folder is an error, so a note in a misspelled `Agent/` folder isn't silently skipped.
- **Names:** the name comes from the file name through `src/config/slug.ts`, and the title is the file name without `.md`. A file name with no letter or digit is an error.
- **Property keys:** unknown ones are errors with a "did you mean" suggestion. `tags`, `aliases`, and `cssclasses` are allowed and ignored.

**Done when:**
- An empty note, frontmatter without a body, and a body without frontmatter are all valid.
- Tests cover the errors above, file names in Cyrillic and with accents, subfolders, and ignored paths.

### 6.1b Note schemas

**Zod schemas**, reusing today's value schemas in `src/config/` (provider options, permissions, time zone, cron, history):
- `Pero.md`
- Agent notes
- Workflow notes

**Workflow schedules:** `day`/`hour`/`minute` become a cron expression, and `trigger` is inferred from them. Lists and single values are accepted for `topics`, `channel`, `day`, and `hour`. `cron` with `day`, `hour`, or `minute` is an error. A `manual` Workflow may keep its times, which then don't run.

**Done when:**
- Unit tests cover every property in the [configuration reference](./CONFIGURATION.md): its default, invalid values, and the schedule mapping (`sunday` 12:00 → `0 12 * * 0`; `weekdays` with `[9, 18]` → `0 9,18 * * 1-5`).

### 6.2 Snapshot and references

`buildSnapshot(files, lookups)`:

1. **Scan the settings folder:** recursive, `.md` only, skipping ignored files and never entering ignored folders, with duplicate names reported against both files.
2. **Parse each note** (6.1, 6.1b).
3. **Resolve references** into an immutable snapshot of `defaults`, `agents`, `mainAgent`, and `workflows`:
   - `main-agent`
   - Workflow `agent`
   - the default Agent from `channel`
   - `topics` claimed twice
   - each Agent's `effort` against its provider, after `Pero.md`
4. **Leave out broken notes.** A broken note is left out along with only the notes that depend on it. A broken `Pero.md` means all defaults, not missing Agents. A topic claimed twice is an error on both notes, which still load, and the topic goes to neither.

Topic titles in `channel` and `history-channels` resolve through an injected lookup. Without one, as in CI, they're checked for syntax only.

**Done when:**
- Tests build snapshots from fixture folders: subfolders, ignored files, duplicate names, a topic claimed twice, a missing main Agent (the default `Main` is then required once a primary Channel needs it), and a Workflow whose Agent is broken.
- Every error names the file and property.

### 6.3 `pero check`

Needs 5.1–5.3a for the workspace and `config.yaml`, and 5.2 for the `.env` checks.

Without Pero running, `pero check` resolves the workspace, loads `config.yaml` and the notes, and prints errors grouped by file. It checks the `.env` permissions and the Git rules from 5.2. Exit 1 on any error. It opens no database, so it runs in CI on a workspace repository. It says that topic titles weren't checked. `--json` prints the errors for tools.

**Done when:**
- `check` passes on the `pero init` skeleton and fails with the expected messages on fixtures.
- It works without the daemon, including `--json`.

### 6.4 Reloading in the daemon

Add a `SettingsNotesModule` whose `SettingsNotes` service holds the current snapshot. It rescans every 10 seconds, on its own interval: what reacts to a change (schedule reconciliation in 9.2) listens for the change event, so it needn't share the scheduler's tick.

1. **Stat** every note.
2. **Reparse** only the changed ones.
3. **Debounce:** a note is reported broken only after two failing scans with the same size and mtime.
4. **Keep last good versions** in memory while the daemon runs. They aren't kept across restarts: a note still broken after a restart loads once it's fixed.
5. **Swap in** the new snapshot and log the changed files.

It also tells listeners of each new snapshot with the notes that changed, and adds a `settings` health component (`ok`, or `degraded — N notes have errors`) to `pero status`, next to 5.3's `config` component for `config.yaml`. A legacy data directory has no notes and no `settings` component.

**Done when:**
- An edited note shows in the snapshot within one tick.
- A note caught mid-write isn't reported.
- A note that becomes broken keeps its last good version and is reported.
- A deleted note leaves the snapshot.
- 500 notes rescan in well under a second.

### 6.3b `pero check` through the daemon

With Pero running, `pero check` asks the daemon through a new `check` control request. The daemon checks the notes as they are on disk now, without the debounce or last good versions, and adds topic resolution against the `channels` table: a title that matches no topic lists the topics Pero has seen, and one that matches several asks for `<chat title>/<topic title>`.

**Done when:**
- It works with and without the daemon.
- Topic errors appear only with the daemon.

### Phase 6 exit criteria

- `pero check` validates any workspace with or without Pero, including in CI.
- The running daemon keeps an up-to-date snapshot of the notes, and `pero status` reports broken ones.
- Behaviour is otherwise unchanged.

## Phase 7 — definitions behind one interface

Make the switch small: consumers stop reading definition tables directly, and state stops pointing at definition rows by ID.

### 7.1a The `Definitions` interface: Agents and defaults

Define `Definitions` in `src/definitions/`, a read-only interface. It is an abstract class, the injection token, and its methods are async so either store can serve them:

- `defaults()`, including the data folder and the shared instructions
- `agent(name)`, `agents()`
- `mainAgent()`
- `onChange(listener)`

Its types name no store: no row IDs and no timestamps. Its first implementation, `SqliteDefinitions`, reads today's tables afresh on each call. The create and edit services still write them, and tell `onChange` listeners once their writes commit.

State still points at definition rows by ID until 7.2 (and a Channel's Agent until 8.2). `DefinitionIds` maps those IDs to names and back, so `Definitions` itself knows names only.

Route every Agent and defaults consumer through it:

- `AgentManager` and `agent-resolution.ts`
- the Channel router stages and onboarding, whose Agent writes move into `AgentsService`
- `ProviderAuthService`, which lists the providers in use
- the history services
- the Agent and Channel views, which drop the Agents' `createdAt` and `updatedAt`, since notes have none
- `config.yaml`'s data folder and backups

Joins from state rows that only turn an ID into a name for display, such as a message's Agent, stay until 7.2 replaces the IDs.

**Done when:**
- A test checks that no module outside `src/definitions/`, `src/persistence/`, and the create/edit services imports the `Agent` or `Settings` entities, apart from the Workflow side 7.1b routes.
- The full test suite passes unchanged, apart from wiring and view fixtures.

### 7.1b The `Definitions` interface: Workflows

Add `workflow(name)` and `workflows()`. A Workflow's definition names its Agent and holds its input, history input, notification targets (Channel IDs, since Channels are state), attempts, and whether it's enabled; schedules come in 7.3. `DefinitionIds` maps Workflow row IDs, which runs still hold until 7.2, to names and back. `TriggersService` keeps the `triggers` rows, which are state as much as definitions, until 7.3 replaces them: `triggers.service.ts` exports the few reads and writes of them that runtime code needs. Route the rest through `Definitions`:

- `WorkflowExecutor`, `WorkflowRuns`, and `ScheduleTick`
- run notifications, which go to the Channels the Workflow notifies as it is defined when the run ends
- the Workflow views, which drop `createdAt`, `updatedAt`, and `concurrencyPolicy` (only `serial` exists, and notes have no such property)

A Workflow or Agent that is gone, which only notes make possible, is treated like a disabled one: its runs fail or aren't retried, and its schedules pass without a run.

**Done when:**
- No module outside `src/definitions/`, `src/persistence/`, and the create/edit services imports the `Agent`, `Workflow`, `Trigger`, `WorkflowNotificationTarget`, or `Settings` entities.
- The full test suite passes unchanged, apart from wiring and view fixtures.

### 7.2 Names instead of IDs in state

A migration switches state tables from IDs to names:

- **`sessions`** gets `agent_name` in place of `agent_id`. The partial unique index becomes `(channel_id, agent_name)` where `status = 'active'`.
- **`messages`** gets `agent_name`.
- **`workflow_runs`** gets `workflow_name`, and the unique key becomes `(workflow_name, trigger_key)`.
- **`workflows`** gets `agent_name` in place of `agent_id`. This is a definition table, but its Workflows must survive `agents` being dropped in 8.5, before they move to notes in 9.1.

The new columns are filled from the current rows, and the foreign keys to `agents` and `workflows` go. Channels keep `agent_id` until 8.2, and Triggers and notification targets keep `workflow_id` until 7.3 and 9.4; `DefinitionIds` serves only those. The execution snapshot (`src/workflows/execution-snapshot.ts`) drops the Agent's row ID: it already records the input the run sent and the Agent name. `pero runs show` and `ls` need no Workflow row, and `--workflow` in `runs ls` and `notifications ls` matches runs by name, so the runs of a Workflow that is gone still list. A name that neither a Workflow nor any run has is still an error.

**Done when:**
- The migration is tested against a database from the current release, with Sessions, messages, and runs all mapped.
- A run whose Workflow row is gone still shows fully.
- Sessions resume across the migration.

### 7.3 Schedule state keyed by name

Add a `schedules` table: `workflow_name`, `fingerprint` (a hash of the cron expression and time zone), `next_run_at`, `last_run_at`. It is filled from the enabled schedule Triggers. `ScheduleTick` reads schedules from `Definitions` and their state from `schedules`:

- **Fingerprint changed:** `next_run_at` is computed afresh.
- **Schedule removed:** its row is dropped.

Trigger keys stay `schedule:<workflow>:<due time>`. A Workflow with several schedule Triggers keeps one row per Trigger until `pero migrate` splits them (7.4).

**Done when:**
- Recovery and catch-up tests pass on the new table.
- Changing a schedule recomputes the next run without a catch-up.
- Removing one drops its state.
- No run is lost or repeated across the migration.

### 7.4 `pero migrate`

`pero migrate <workspace>` converts an installation into a workspace, as [Migration](./MIGRATION.md#moving-an-existing-installation) describes:

1. **Opens the old database read-only, in-process.** The CLI otherwise never opens a database. This is a documented exception, like `restore` touching files, and it refuses while a daemon answers for that data directory.
2. **Runs `pero init`.**
3. **Writes the notes:** `Pero.md`, one note per Agent (with `topics` from its Channel assignments), and one note per Workflow (splitting several schedules into several notes).
4. **Writes `config.yaml` and `.env`.**
5. **Copies the database** into `.pero/`.
6. **Runs `pero check`.**

The old installation is left untouched.

**Done when:**
- Migrating fixture databases gives notes that `pero check` passes, and whose snapshot describes the same Agents, defaults, topic routes, Workflows, schedules, and notification targets as the database (compared in a test).
- Conflicting topic titles stop the command with a list.
- The source directory is byte-for-byte unchanged.

### Phase 7 exit criteria

- All runtime code reads definitions through `Definitions`.
- State refers to Agents and Workflows by name.
- Every existing installation can be converted to a workspace with `pero migrate`, and its snapshot matches its database.

## Phase 8 — Agents from notes

Switch Agents, defaults, and topic routing to notes. From here, a workspace without notes, or a legacy data directory that hasn't been migrated, starts degraded and says to run `pero migrate`.

### 8.1 Agents and defaults from the snapshot

Add `FileDefinitions` for Agents and defaults, backed by the 6.4 snapshot, and make it the implementation used. Workflows still come from SQLite until 9.1.

- **Defaults from `Pero.md` apply live.**
- **An Agent whose provider or folder changes** starts a fresh Session on its next turn, per the existing Session policy.
- **`pero agents ls`/`show`** show the note path, effective values with where each comes from (note or `Pero.md`), topics, and the note's errors.
- **Stubs:** `pero agents create`/`edit`/`enable`/`disable` and `pero settings set`/`unset` (except `telegram-bot-token`) name the note to edit.
- **`pero settings show`** reads `config.yaml` and `Pero.md`.

**Done when:**
- Editing an Agent note's body, `model`, or `effort` changes the next turn in the same Session.
- Editing `provider` or `working-directory` starts a fresh Session that carries over history.
- Editing `Pero.md` changes every Agent that doesn't override the value.
- Stubs print the right path.

### 8.2 Topic routing by `topics`

The router chooses the Agent from the snapshot on each message, through a new `Definitions.agentForTopic(title)`:

- **A primary Channel** gets the main Agent.
- **A topic** gets the Agent whose `topics` claims its title.

The change comes with a migration and CLI updates:

- **Migration:** drops `channels.agent_id` and `channels.enabled`.
- **Route changes:** a turn whose route changed closes the old Session, and the new Agent's first turn carries over history.
- **Topics that can't be answered** get one reply saying why: a disabled Agent, a conflict, or a broken note that never loaded.
- **`pero channels ls`/`show`** show the current route.
- **Stubs:** `pero channels assign`/`enable`/`disable`.

**Done when:**
- Adding a title to an Agent's `topics` moves that topic on its next message.
- A topic claimed twice is answered by neither, with one explanation.
- Disabling an Agent silences its topics.
- General topics and direct chats reach the main Agent.

### 8.3 Onboarding writes notes

Rewrite `ChannelOnboardingService` around notes:

- **An unclaimed topic:** with `new-topics: create-agent`, Pero writes `Agents/<Topic title>.md` from `_Template.md`, with `topics` set, and posts the welcome. With `main-agent`, the main Agent answers.
- **File names:** characters invalid in file names are replaced, and an existing file is never overwritten (`Health 2.md`).
- **A missing main Agent note** is created as `Main.md` the first time a primary Channel needs it.
- **A topic rename** rewrites that title in the claiming note's `topics` through the `yaml` document API.
- **Every note write** is atomic (temporary file, then rename) and logged.
- **No reload wait:** the new note enters the snapshot at once, without waiting for the next scan.

**Done when:**
- A created topic yields exactly one note even when the topic-created event and the first message race.
- The template's properties and body are used.
- A rename keeps the topic on its Agent, and keeps the note's comments and body.
- `main-agent` mode writes nothing.

### 8.4 Protecting the settings folder

Today Claude `ask` Agents run in `acceptEdits` mode, which approves edits in the working folder without asking Pero. Replace it with Pero's own policy in `canUseTool`:

- **Edits in the working folder** are allowed without asking, except paths under the settings folder, resolved through symlinks.
- **Edits under the settings folder** ask in the Channel.
- **In Workflow runs,** where no one can approve, they are refused.

`bypass` and Codex are unchanged. The Codex limitation is documented.

**Done when:**
- Tests show a Claude `ask` Agent edits a note in the vault without a prompt, but is asked before editing `Settings/Agents/Health.md` (including through a symlink or a `../` path) and refused in a Workflow run.
- `bypass` edits freely.

### 8.5 Drop Agent tables

A migration drops `agents` and `settings`. Remove `SettingsService`, the create and edit parts of `AgentsService`, `SqliteDefinitions`' Agent side, and their CLI option parsing (`src/cli/agent-options.ts`, `src/cli/settings-keys.ts`).

**Done when:**
- The schema has no Agent or settings tables.
- No dead code remains for them.
- The full suite and packed-install job pass.

### Phase 8 exit criteria

- Agents, their prompts, defaults, and which topic each answers are configured only by notes, and changes apply within 10 seconds.
- New topics create notes.
- Claude `ask` Agents can't change configuration without asking.
- A migrated installation answers every topic as before.

## Phase 9 — Workflows from notes

### 9.1 Workflows from the snapshot

`FileDefinitions` now serves Workflows too:

- **`channel`** resolves to Channels by title, `chat/topic`, `General`, or ID, through the `channels` table. It gives the notification targets and the default Agent.
- **`history-channels`** resolves the same way.
- **`pero workflows ls`/`show`** show the note path, the schedule as cron, the next run, and the resolved Channels.
- **`pero workflows run`** works for any Workflow, with no manual Trigger needed.
- **Stubs:** `pero workflows create`/`edit`/`enable`/`disable`/`notify` and `pero triggers …`.

**Done when:**
- The weekly-report note from the [overview](./README.md#a-workspace-in-five-notes) runs by hand, answered by the Health Agent, and posts to Health.
- A title that matches no topic, or several, is an error in `pero check` and `status`.

### 9.2 Schedule reconciliation

On each `snapshotChanged` event and at startup, reconcile `schedules` with the snapshot:

- **A new schedule** gets its next run computed from now.
- **A changed fingerprint** recomputes the next run without catch-up.
- **A removed or disabled Workflow** drops its row and cancels its waiting runs. A running one finishes.

Startup catch-up applies only to notes that still exist and are enabled.

**Done when:**
- Editing `hour` moves the next run within one tick.
- Deleting the note cancels a waiting run.
- Renaming a note starts a fresh schedule and history window.
- Times missed while Pero was down still coalesce into one catch-up run.

### 9.3 Configuration errors in Telegram

When a note becomes broken, Pero posts one message per broken version (keyed by content hash), naming the note, property, and reason, and that the last good version stays in use. It goes to the note's related Channels (an Agent's topics, a Workflow's `channel`), or else to the main Agent's primary Channel. The message isn't recorded in Channel history. When the note is fixed, Pero logs it but doesn't post.

**Done when:**
- A typo in a Workflow's `channel` produces exactly one message, a further edit that's still broken produces one more, and fixing it produces none.
- Messages go to the right Channel.

### 9.4 Drop Workflow tables

A migration drops `workflows`, `triggers`, `workflow_notification_targets`, and `allowed_chats`. Remove `TriggersService`, the create and edit parts of `WorkflowsService`, `SqliteDefinitions`, and `src/cli/workflow-options.ts`.

**Done when:**
- The schema holds only state (`channels`, `sessions`, `messages`, `workflow_runs`, `notifications`, `schedules`, `inbound_updates`).
- The full suite passes.

### Phase 9 exit criteria

- Workflows, their schedules, prompts, and targets are configured only by notes.
- Schedule edits apply within 10 seconds without spurious catch-up runs.
- Recovery, retries, and notifications behave as before.
- Broken notes are reported in Telegram once.

## Phase 10 — ship

### 10.1 Example workspace and end-to-end test

Add `examples/workspace/` with:

- `config.yaml` (placeholder chat ID)
- `Pero.md`
- `Main.md`, `Health.md`, and `_Template.md`
- the weekly-report and evening-review Workflows

A CI job runs `pero check` on it. An e2e test copies it, writes `.env`, and runs Pero with the echo runtime and fake Telegram adapter. It then checks:

- Health answers the Health topic.
- A new topic writes a note.
- Editing a note changes the answer.
- The weekly report runs on a mocked clock and posts to Health.

**Done when:** the job and the e2e test pass on the CI matrix.

### 10.2 Docs

Rewrite the [README](../../README.md), [User guide](../USER_GUIDE.md), [CLI reference](../CLI.md), [Operations](../OPERATIONS.md), [Architecture](../ARCHITECTURE.md), and [Testing](../TESTING.md) from this proposal. Add an upgrade section: back up, `npm install -g`, `pero migrate ~/workspace`, `pero run`. Move the finished plan into `docs/IMPLEMENTATION_PLAN.md` and delete `docs/vision/`.

**Done when:** no doc describes SQLite-held definitions or removed commands except as stubs, and every link resolves.

### 10.3 Release 0.2.0

Bump to `0.2.0`, which the release workflow publishes. Before tagging, run `pero migrate` on a real 0.1 installation, as a checklist item in the PR.

**Done when:** a 0.1 installation upgraded by the documented steps answers every topic and runs every Workflow as before.

### After 0.2.0

A later release removes the command stubs, the legacy data directory (`--data-dir`, `PERO_HOME`, `~/.pero`), and the `secrets/` fallback.

## Open questions to settle before the phase that needs them

| Question | Needed by | Proposed default |
|---|---|---|
| Unclaimed topic: new note or main Agent? | 8.3 | New note (`create-agent`), as today |
| Report Codex changes under the settings folder? | 8.4 | No: documented limitation |
| Accept topic IDs in `topics`? | 8.2 | No: titles only |
| Several schedules per Workflow note? | 7.4 | No: one note per schedule |
