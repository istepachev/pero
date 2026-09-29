# Pero

**Your own always-on AI assistant, running on your server and reachable from Telegram. It uses the Claude or ChatGPT subscription you already pay for.**

Pero keeps Claude Code or Codex running on your VPS or home machine and puts it in your pocket. Chat with it from your phone, give each topic its own assistant, and let it work on a schedule: reviewing your day, summarizing notes, or checking on a project, then messaging you with what it found.

- **No API bills.** Pero uses the Claude Code or Codex sign-in on your machine, so it runs on your existing Claude or ChatGPT subscription. It never switches you to pay-per-token API billing.
- **One Telegram group, many assistants.** Every topic in your group is a separate conversation with an Agent of its own: one for your notes, one for a side project, one that coaches your English. A new topic creates a new Agent.
- **It works where your files are.** Agents work in a folder you choose, such as a notes vault or a Git repository. They read and edit files there the way Claude Code or Codex does, with your `CLAUDE.md`, `AGENTS.md`, skills, and MCP servers.
- **It works while you're away.** Workflows run on a schedule, can read what you talked about during the day, and post their results to the topic you choose. You can reply to them right there.
- **You stay in control.** By default, an Agent asks before running a command. Pero posts the request in the chat with Allow and Deny buttons. Only chats you allow can reach your Agents.
- **Easy to run.** Pero is one npm package and one background process, with its data in a single SQLite file. You don't need Docker, a database server, or an open network port, and a single command backs everything up.

## What you need

- A Linux or macOS machine that stays on, such as a small VPS
- Node.js 22.17+ or 24.11+
- A Claude subscription signed in with Claude Code (`claude auth login`), a ChatGPT subscription signed in with Codex (`codex login`), or both
- A Telegram account
- Optional: an [Obsidian](https://obsidian.md) vault for your Agents to work in (see [below](#tip-use-an-obsidian-vault))

## Get started

1. **Install and start Pero:**

   ```sh
   npm install -g @perokit/pero
   pero run
   ```

   On first run, Pero asks for what it needs: the folder your Agents work in, your Telegram bot token, and a provider sign-in. You can stop at any step and run `pero run` again later to continue.

2. **Create a Telegram bot** with [@BotFather](https://t.me/BotFather), then paste its token when `pero run` asks for it.

3. **Create a private Telegram group,** turn on **Topics** in its settings, and add your bot as an **administrator**.

4. **Allow the group.** Write anything in it. `pero run` offers to allow that chat. You can also allow it later with the command the bot replies with: `pero telegram allow <chat-id>`.

5. **Create a topic and start chatting.** Each new topic gets its own Agent, named after the topic. The General topic talks to your main Agent.

You can also message the bot directly and allow your user ID the same way. That chat talks to your main Agent, too.

### Tip: use an Obsidian vault

Agents keep their notes, plans, and results as files in their working folder. Make that folder an [Obsidian](https://obsidian.md) vault, and everything they write becomes plain Markdown notes that you can browse, search, and edit on your desktop and phone.

1. Create the vault folder on the server, such as `~/notes`, and choose it when `pero run` asks for the working folder (or later: `pero settings set default-working-directory ~/notes`).
2. Sync it to your devices with a tool that works on a headless server, such as [Syncthing](https://syncthing.net) or Git with the [Obsidian Git](https://github.com/Vinzent03/obsidian-git) plugin.
3. Open the synced folder as a vault in Obsidian on your desktop and phone.

Codex Agents only work inside a Git repository. If you sync with Git, the vault already is one. Otherwise, run `git init` in the vault.

## Everyday use

```sh
pero status                # is Pero running, and is everything connected?
pero logs -f               # follow the logs
pero agents                # your Agents, their provider, model, and folder
pero agents edit notes --provider codex --model gpt-5.5
pero channels              # topics and chats, and which Agent answers in each
pero settings              # installation-wide settings
pero stop
```

### Scheduled workflows

A Workflow is a task an Agent does on its own, on a schedule or on demand. For example, this Workflow reviews the day's chats every evening and posts suggestions to a topic:

```sh
pero agents create english-coach --instructions "You are a friendly English tutor."
pero workflows create english --agent english-coach --history \
  --input "Suggest better English for: {{history}}"
pero triggers add english --cron "0 21 * * *"   # every day at 21:00
pero workflows notify english 5                 # post results to Channel 5 (see `pero channels`)
```

`pero runs` shows what ran and how it went.

### Keep it running and back it up

`pero run` keeps Pero running after you close the terminal. To start it again after a reboot, run `pero run --foreground` under systemd or another service manager. [Operating Pero](./docs/OPERATIONS.md) has a ready-to-use unit file.

```sh
pero backup ~/backups/pero.tgz     # while Pero runs
pero restore ~/backups/pero.tgz    # into an empty data directory, while Pero is stopped
```

## Learn more

- [User guide](./docs/USER_GUIDE.md): Telegram, Agents and permissions, Workflows, and settings in detail
- [Operating Pero](./docs/OPERATIONS.md): running as a service, upgrades, credentials, data, backup, and moving to a new machine
- [CLI reference](./docs/CLI.md): every command and option
- [Development](./docs/DEVELOPMENT.md): building, testing, and contributing to Pero

## License

[MIT](./LICENSE)
