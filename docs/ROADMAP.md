# Pero roadmap

What comes next for Pero. Git keeps how it was built: the plan that led up to 0.2.0, phase by phase with each step's acceptance criteria and what was found while building it, is `docs/IMPLEMENTATION_PLAN.md` as of commit `d937419` (`git show d937419:docs/IMPLEMENTATION_PLAN.md`).

## Next

### 11.10 Release 0.2.0

- Bump to `0.2.0`, which the release workflow publishes. 0.1.0 can't be reused on npm, even after an unpublish.
- Run `npm deprecate @perokit/pero@0.1.0` with a message pointing to 0.2.0, so nobody installs it by accident.
- Before tagging, walk through the README's "Get started" on a fresh VPS with a real bot, as a checklist item in the PR: `pero init`, `pero run`, allow a group, onboard a topic, edit a note, run a Workflow, back up, and restore into a clone.

**Done when:** 0.2.0 is on npm, 0.1.0 is deprecated, and the checklist passes on a fresh machine.

## Open items

- **Protect `.env` and `.pero/` in the edit policy.** A Claude `ask` Agent edits files in its folder without asking, except the settings folder and tool files such as `.claude/` and `.git/`. An Agent whose folder is the workspace root, such as with `data: .`, can therefore edit the bot token in `.env` and the allowed chats in `.pero/config.yaml` without asking. The edit policy should ask for those too; until it does, [Configuring Pero](./CONFIGURATION.md) advises a data folder of its own.

## Decided against

| Question | Answer |
|---|---|
| Keep the last good version of a broken note across restarts? | No: it is kept in memory only, since a stored copy could drift from the file. |
| Report Codex changes under the settings folder? | No: a documented limitation. Give such a Codex Agent a `working-directory` outside the settings folder. |
| Accept topic IDs in `topics`? | No: titles only, so a workspace stays portable. |
| Several schedules per Workflow note? | No: one note per schedule. |
