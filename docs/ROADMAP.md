# Pero roadmap

What comes next for Pero.

## Open items

- **Protect `.env` and `.pero/` in the edit policy.** A Claude `ask` Agent edits files in its folder without asking, except the settings folder and tool files such as `.claude/` and `.git/`. An Agent whose folder is the workspace root, such as with `data: .`, can therefore edit the bot token in `.env` and the allowed chats in `.pero/config.yaml` without asking. The edit policy should ask for those too; until it does, [Configuring Pero](./CONFIGURATION.md) advises a data folder of its own.

## Decided against

| Question | Answer |
|---|---|
| Keep the last good version of a broken note across restarts? | No: it is kept in memory only, since a stored copy could drift from the file. |
| Report Codex changes under the settings folder? | No: a documented limitation. Give such a Codex Agent a `working-directory` outside the settings folder. |
| Accept topic IDs in `topics`? | No: titles only, so a workspace stays portable. |
| Several schedules per Workflow note? | No: one note per schedule. |
