import type { SettingsView } from '../control/protocol.js';
import { table } from './format-status.js';
import { SETTINGS_KEYS } from './settings-keys.js';

/** `pero settings show`: each setting by the name `pero settings set` takes. */
export function formatSettings(view: SettingsView): string {
  return table(SETTINGS_KEYS.map((key) => [key.name, key.show(view)])).join(
    '\n',
  );
}
