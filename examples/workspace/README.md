# Example workspace

A Pero workspace with a main Agent, a Health Agent for the Health topic, and two Workflows. To try it:

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
| `data/Settings/Pero.md` | Defaults for every Agent and Workflow |
| `data/Settings/Agents/Main.md` | The main Agent: General and direct chats; every other Agent starts with its instructions |
| `data/Settings/Agents/Health.md` | The Agent of the Health topic |
| `data/Settings/Agents/_Template.md` | Optional, not written by `pero init`: the starting point for the Agent of each new topic |
| `data/Settings/Workflows/Weekly health report.md` | Sundays at 12:00, a report from the training log, posted to Health |
| `data/Settings/Workflows/Evening review.md` | Every evening at 21:00, what the day's chats left open, posted to General |

A Workflow's `channel` names a topic by its title, and Pero must have seen the topic first: write something in Health and General before the Workflows run. [Configuring Pero](../../docs/CONFIGURATION.md) describes every file and property.
