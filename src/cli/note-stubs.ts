import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type BootstrapConfig,
  ConfigError,
  STATE_DIR_NAME,
} from '../config/bootstrap-config.js';
import {
  hostConfigPath,
  readHostConfig,
  resolveSettingsFolder,
} from '../config/host-config.js';
import {
  type AgentAction,
  agentHint,
  type ConfigurationFiles,
  findAgentNote,
  legacyHint,
  SETTING_HOMES,
  settingHint,
} from '../settings-files/note-hints.js';
import { scanSettingsFolder } from '../settings-files/scan.js';
import { CliError } from './errors.js';

/*
 * The commands that changed Agents and settings, now that notes hold them:
 * they say which file to edit and exit 1, whether or not Pero runs.
 */

/**
 * The configuration files of the workspace `config` found; a `CliError`
 * with the migrate hint for a legacy data directory.
 */
export function configurationFiles(
  config: Pick<BootstrapConfig, 'workspace' | 'dataDir'>,
): ConfigurationFiles {
  const { workspace, dataDir } = config;
  if (workspace === null) throw new CliError(legacyHint(dataDir));
  const configFile = hostConfigPath(join(workspace, STATE_DIR_NAME));
  let settings = { data: null, settings: null } as {
    data: string | null;
    settings: string | null;
  };
  try {
    settings = readHostConfig(configFile) ?? settings;
  } catch (error) {
    // An invalid file names the default folders; pero check reports it.
    if (!(error instanceof ConfigError)) throw error;
  }
  return {
    workspace,
    configFile,
    settingsFolder: resolveSettingsFolder(settings, workspace, homedir()),
  };
}

/** `pero agents <action> <name>`: names the note to edit instead. */
export async function agentStub(
  config: Pick<BootstrapConfig, 'workspace' | 'dataDir'>,
  action: AgentAction,
  name: string,
): Promise<never> {
  const files = configurationFiles(config);
  const notes = await scanSettingsFolder(files.settingsFolder);
  const note = findAgentNote(
    notes.map((entry) => entry.file),
    name,
  );
  throw new CliError(agentHint(action, name, note, files));
}

/**
 * `pero settings set` or `unset` of `key`: names the file to edit instead;
 * undefined for a key that is still set this way, the bot token.
 */
export function settingStub(
  config: Pick<BootstrapConfig, 'workspace' | 'dataDir'>,
  key: string,
): void {
  const home = SETTING_HOMES[key];
  if (home === undefined) return;
  throw new CliError(settingHint(home, configurationFiles(config)));
}
