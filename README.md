# Pero

**Your own always-on AI assistant, running on your server and reachable from Telegram. It uses the Claude or ChatGPT subscription you already pay for.**

Pero keeps Claude Code or Codex running on your VPS or home machine and puts it in your pocket. Chat with it from your phone, give each topic its own assistant, and let it work on a schedule: reviewing your day, summarizing notes, or checking on a project, then messaging you with what it found.

- **No API bills.** Pero uses the Claude Code or Codex sign-in on your machine, so it runs on your existing Claude or ChatGPT subscription. It never switches you to pay-per-token API billing.
- **One Telegram group, many assistants.** Every topic in your group is a separate conversation with an Agent of its own: one for your notes, one for a side project, one that coaches your English. A new topic creates a new Agent.
- **It works where your files are.** Agents work in a folder you choose, such as a notes vault or a Git repository. They read and edit files there the way Claude Code or Codex does, with your `CLAUDE.md`, `AGENTS.md`, skills, and MCP servers.
- **It works while you're away.** Workflows run on a schedule, can read what you talked about during the day, and post their results to the topic you choose. You can reply to them right there.
- **You stay in control.** By default, an Agent asks before running a command. Pero posts the request in the chat with Allow and Deny buttons. Only chats you allow can reach your Agents.
- **Configured by notes.** Each Agent and Workflow is a Markdown note: its text is the prompt, and its properties set the model, schedule, and topic. Edit them in Obsidian on your phone, commit them to Git, or clone them onto a new server. Changes apply within seconds.
- **Easy to run.** Pero is one npm package and one background process, with its state in a single SQLite file. You don't need Docker, a database server, or an open network port, and a single command backs everything up.

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

   From your home folder, `pero run` offers to make the workspace in `~/workspace`: the folder Pero runs in, with your Agents' data folder in `data/` and Pero's own state in `.pero/`. (From another folder, it offers that folder.) Then it asks for what it still needs: your Telegram bot token and a provider sign-in. You can stop at any step and run `pero run` again later to continue. Commands find `~/workspace` from your home folder and from any folder inside it.

   To make a workspace without starting Pero, such as from a script or in another folder, run `pero init <dir>`. It only writes what's missing, so it also fills in a cloned workspace.

2. **Create a Telegram bot** with [@BotFather](https://t.me/BotFather), then paste its token when `pero run` asks for it.

3. **Create a private Telegram group,** turn on **Topics** in its settings, and add your bot as an **administrator**.

4. **Allow the group.** Write anything in it. `pero run` offers to allow that chat. You can also allow it later with the command the bot replies with: `pero telegram allow <chat-id>`.

5. **Create a topic and start chatting.** Each new topic gets its own Agent, named after the topic: a note Pero writes in `data/Settings/Agents/`, whose text is the Agent's instructions. The General topic talks to your main Agent, `Agents/Main.md`.

You can also message the bot directly and allow your user ID the same way. That chat talks to your main Agent, too.

To start from a complete setup instead, with a Health Agent and two Workflows, copy the [example workspace](./examples/workspace/).

### Tip: use an Obsidian vault

Agents keep their notes, plans, and results as files in their working folder. Make that folder an [Obsidian](https://obsidian.md) vault, and everything they write becomes plain Markdown notes that you can browse, search, and edit on your desktop and phone.

1. Use the workspace's `data/` folder as the vault, or point Pero at another folder with `data: ~/notes` in `.pero/config.yaml` and restart it.
2. Sync it to your devices with a tool that works on a headless server, such as [Syncthing](https://syncthing.net) or Git with the [Obsidian Git](https://github.com/Vinzent03/obsidian-git) plugin.
3. Open the synced folder as a vault in Obsidian on your desktop and phone.

Codex Agents only work inside a Git repository. If you sync with Git, the vault already is one. Otherwise, run `git init` in the vault.

## Everyday use

```sh
pero status                # is Pero running, and is everything connected?
pero logs -f               # follow the logs
pero agents                # your Agents, their provider, model, and folder
pero channels              # topics and chats, and which Agent answers in each
pero settings              # the defaults in effect
pero check                 # any mistakes in the notes?
pero stop
```

### Agents are notes

To change an Agent, edit its note. `data/Settings/Agents/Health.md` answers in the Health topic with its own model:

```markdown
---
topics: [Health]
provider: codex
model: gpt-5.5
---
You are my health coach. My training log is in Health/Log.md.
```

Defaults for every Agent, such as the provider, model, and time zone, are properties of `data/Settings/Pero.md`, and its text is instructions every Agent shares. Pero reads the notes every 10 seconds, so the next message uses your edit. A note with a mistake doesn't stop Pero: it keeps the note's last good version, and tells you in the chat what's wrong. [Configuring Pero](./docs/CONFIGURATION.md) lists every property.

### Scheduled workflows

A Workflow is a task an Agent does on its own, on a schedule or on demand: a note in `Workflows/`. For example, `data/Settings/Workflows/English review.md` reviews the day's chats every evening and posts suggestions to the English topic:

```markdown
---
hour: 21
agent: english-coach
history: true
channel: English
---
Suggest better English for: {{history}}
```

`pero workflows` lists the Workflows and when each runs next, and `pero workflows run english-review` runs one now.

`pero runs` shows what ran and how it went.

### Keep it running and back it up

`pero run` keeps Pero running after you close the terminal. To start it again after a reboot, run `pero run --foreground` under systemd or another service manager. [Operating Pero](./docs/OPERATIONS.md) has a ready-to-use unit file.

```sh
pero backup ~/backups/pero.tgz     # while Pero runs; --include-data adds the data folder
pero restore ~/backups/pero.tgz    # into a workspace without a database, such as a fresh clone, while Pero is stopped
```

## Learn more

- [User guide](./docs/USER_GUIDE.md): Telegram, Agents and permissions, and Workflows in detail
- [Configuring Pero](./docs/CONFIGURATION.md): the workspace, and every file and property
- [Operating Pero](./docs/OPERATIONS.md): running as a service, upgrades, credentials, data, backup, and moving to a new machine
- [CLI reference](./docs/CLI.md): every command and option
- [Development](./docs/DEVELOPMENT.md): building, testing, and contributing to Pero

## License

[MIT](./LICENSE)
