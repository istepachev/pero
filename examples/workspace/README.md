# Example workspace

A Pero workspace with a personality, shared instructions, a note for the Health topic, and two Workflows. To try it:

```sh
cp -r examples/workspace ~/workspace
cd ~/workspace
pero check        # no problems
pero run          # asks for the bot token and writes it to .env
```

Replace the chat ID in `.pero/config.yaml` with your group's first, or run `pero telegram allow <chat ID>`. Once you write in a group Pero doesn't serve yet, `pero telegram chats` lists it with its ID.

| File | What it configures |
|---|---|
| `.pero/config.yaml` | The data folder, and the group Pero serves |
| `data/System/Pero.md` | Defaults for every Channel and Workflow |
| `data/System/Persona.md` | Pero's personality, which every Channel starts with |
| `data/System/Instructions.md` | Pero's general instructions, which follow the personality everywhere |
| `data/System/Channels/Default.md` | General topics and direct chats |
| `data/System/Channels/Health.md` | The Health topic: its own instructions and effort |
| `data/System/Channels/_Template.md` | Optional, not written by `pero init`: the starting point for the note of each new topic |
| `data/System/Workflows/Weekly health report.md` | Sundays at 12:00, a report from the training log, posted to Health |
| `data/System/Workflows/Evening review.md` | Every evening at 21:00, what the day's chats left open, posted to General |

`Health.md` has no `channel-id` yet: the first time you write in a topic titled Health, Pero binds the note to it, and the note stays with that topic even if you rename it. A Workflow's `channel` names a Channel note, or `General`, and Pero must have seen the topic first: write something in Health and General before the Workflows run. [Configuring Pero](../../docs/CONFIGURATION.md) describes every file and property.
