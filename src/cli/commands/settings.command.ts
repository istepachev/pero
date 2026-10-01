import { Command } from 'nest-commander';
import { formatSettings } from '../format-settings.js';
import { PeroCommand } from '../pero-command.js';

@Command({
  name: 'settings',
  description:
    "Show the settings in effect: Pero.md's properties, the data folder, and whether the Telegram bot token is set",
})
export class SettingsCommand extends PeroCommand {
  async run(): Promise<void> {
    const { client } = await this.requireDaemon();
    console.log(formatSettings(await client.call('settings.get')));
  }
}
