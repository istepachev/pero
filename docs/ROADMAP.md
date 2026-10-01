# Pero roadmap

What comes next for Pero.

## Open items

- **Protect `.env` and `.pero/` in the edit policy.** A Claude `ask` Agent edits files in its folder without asking, except the settings folder and tool files such as `.claude/` and `.git/`. An Agent whose folder is the workspace root, such as with `data: .`, can therefore edit the bot token in `.env` and the allowed chats in `.pero/config.yaml` without asking. The edit policy should ask for those too; until it does, [Configuring Pero](./CONFIGURATION.md) advises a data folder of its own.

## Decided against

| Question | Answer |
|---|---|
| Keep the last good version of a broken note across restarts? | No: it is kept in memory only, since a stored copy could drift from the file. |
| Report Codex changes under the settings folder? | No: a documented limitation. Give such a Codex Agent a `working-directory` outside the settings folder. |
| Accept topic IDs in `topic`? | No: titles only, so a workspace stays portable. |
| One Agent answering several topics? | No: one topic, one Agent. The main Agent answers General topics and direct chats, and its instructions start every other Agent's, so a shared personality lives in `Main.md`, not `Pero.md`. |
| A migration from `topics`, `shared-instructions`, `new-topics`, and a `Pero.md` body? | No: Pero had no installations to carry over, so the old properties are plain errors. |
| Several schedules per Workflow note? | No: one note per schedule. |
