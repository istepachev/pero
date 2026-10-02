# Pero roadmap

What comes next for Pero.

## Open items

- **Protect `.env` and `.pero/` in the edit policy.** With Claude and `ask`, Pero edits files in its folder without asking, except the system folder and tool files such as `.claude/` and `.git/`. A Channel whose folder is the workspace root, such as with `data: .`, can therefore edit the bot token in `.env` and the allowed chats in `.pero/config.yaml` without asking. The edit policy should ask for those too; until it does, [Configuring Pero](./CONFIGURATION.md) advises a data folder of its own.

## Decided against

| Question | Answer |
|---|---|
| Keep the last good version of a broken note across restarts? | No: it is kept in memory only, since a stored copy could drift from the file. |
| Report Codex changes under the system folder? | No: a documented limitation. Give such a Codex Channel a `working-directory` outside the system folder. |
| Match topics to notes by title only? | No: a topic's note records its `channel-id`, the chat's ID and the topic's, which stays the same across renames and a fresh database for the same group. The title only binds a note written before its topic, once. |
| Rename a note's file when its topic is renamed? | No: the note is bound by `channel-id`, and Workflows name it by its file name, which renaming would break. |
| Agents of their own per topic, or a main Agent? | No: Pero is one assistant. `Persona.md` and `Instructions.md` start every turn, and each Channel's note adds its own instructions and settings; `Default.md` answers General topics and direct chats. |
| An opt-out of `Persona.md` or `Instructions.md` for one Channel? | No: a Channel that must differ says so in its own note. |
| A migration from `Agents/`, `Main.md`, `main-agent`, `topic`, `skip-main-instructions`, and a Workflow's `agent`? | No: move the notes by hand, as the release notes say; the old properties are plain errors, and Pero no longer reads `Agents/`. |
| A migration from `topics`, `shared-instructions`, `new-topics`, and a `Pero.md` body? | No: Pero had no installations to carry over, so the old properties are plain errors. |
| Several schedules per Workflow note? | No: one note per schedule. |
| A `/permissions` command? | No: anyone in an allowed chat may use commands, and switching a Channel to `bypass` from the chat would get around the Allow and Deny buttons. Change `permissions` in the note. |
| Answer an unknown `/command` with Pero's list? | No: it is answered as text, as before commands existed; `/help` lists Pero's own. |
| Context usage for Codex in `/status`? | No: Codex reports the tokens a whole turn used, summed over its calls, which overstates the context; the line is left out. |
