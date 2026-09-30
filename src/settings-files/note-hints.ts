import { join, posix, relative } from 'node:path';
import { slugify } from '../config/slug.js';
import { NOTE_FOLDERS, noteIdentity, PERO_NOTE } from './note-files.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/*
 * What the commands that changed Agents and settings say now that notes
 * hold them: the file to edit instead. They stay as such stubs for one
 * release.
 */

/** Where a workspace's configuration files are, absolute. */
export interface ConfigurationFiles {
  workspace: string;
  /** `.pero/config.yaml`. */
  configFile: string;
  settingsFolder: string;
}

/** Where a `pero settings` key's value lives now. */
export type SettingHome =
  | { file: 'pero'; property: string }
  /** `Pero.md`'s body: the shared instructions. */
  | { file: 'pero-body' }
  | { file: 'config'; property: 'data' };

/** Every `pero settings` key but the bot token, by where it lives now. */
export const SETTING_HOMES: Readonly<Record<string, SettingHome>> = {
  'default-provider': { file: 'pero', property: 'provider' },
  'claude.model': { file: 'pero', property: 'claude-model' },
  'claude.effort': { file: 'pero', property: 'claude-effort' },
  'codex.model': { file: 'pero', property: 'codex-model' },
  'codex.effort': { file: 'pero', property: 'codex-effort' },
  'default-working-directory': { file: 'config', property: 'data' },
  'shared-instructions': { file: 'pero-body' },
  'main-agent': { file: 'pero', property: 'main-agent' },
  'history-carryover': { file: 'pero', property: 'history-carryover' },
  'history-retention-days': {
    file: 'pero',
    property: 'history-retention-days',
  },
  'default-permissions': { file: 'pero', property: 'permissions' },
  timezone: { file: 'pero', property: 'timezone' },
  'max-concurrent-runs': { file: 'pero', property: 'max-concurrent-runs' },
};

/** `path` as the owner reads it: inside the workspace, relative to it. */
export function shownPath(workspace: string, path: string): string {
  const inside = relative(workspace, path);
  return inside === '' || inside.startsWith('..') ? path : inside;
}

/** What to edit instead of changing setting `key`. */
export function settingHint(
  home: SettingHome,
  files: ConfigurationFiles,
): string {
  const pero = shownPath(
    files.workspace,
    join(files.settingsFolder, PERO_NOTE),
  );
  switch (home.file) {
    case 'pero':
      return `Settings are in notes now: set ${home.property} in ${pero}.`;
    case 'pero-body':
      return `Settings are in notes now: edit the body of ${pero}, which goes before each Agent's own instructions.`;
    case 'config':
      return `The data folder is set in config.yaml now: set data in ${shownPath(files.workspace, files.configFile)}, then restart Pero.`;
  }
}

/** A command that changed an Agent. */
export type AgentAction = 'create' | 'edit' | 'enable' | 'disable';

/**
 * The note that defines the Agent named `name`, in any case or as its
 * title, among `files`, the paths in the settings folder; null if none.
 */
export function findAgentNote(
  files: readonly string[],
  name: string,
): string | null {
  const wanted = slugify(name) ?? name.toLowerCase();
  for (const file of files) {
    const found = noteIdentity(file);
    if (
      found.ok &&
      found.identity.kind === 'agent' &&
      found.identity.name === wanted
    ) {
      return file;
    }
  }
  return null;
}

/**
 * What to edit instead of `pero agents <action> <name>`, given `note`,
 * the path of the Agent's note in the settings folder, or null.
 */
export function agentHint(
  action: AgentAction,
  name: string,
  note: string | null,
  files: ConfigurationFiles,
): string {
  const shown = (file: string) =>
    shownPath(files.workspace, join(files.settingsFolder, file));
  const prefix = 'Agents are configured in notes now';
  const template = posix.join(NOTE_FOLDERS.agent, '_Template.md');
  const add = `add ${shown(posix.join(NOTE_FOLDERS.agent, `${name}.md`))} (${template} shows the properties)`;
  if (note === null) {
    return action === 'create'
      ? `${prefix}: ${add}.`
      : `${prefix}, and no note is named ${name}: ${add}.`;
  }
  switch (action) {
    case 'create':
      return `${prefix}, and ${shown(note)} already defines ${name}; edit it there.`;
    case 'edit':
      return `${prefix}: edit ${shown(note)}.`;
    case 'enable':
    case 'disable':
      return `${prefix}: set enabled: ${action === 'enable'} in ${shown(note)}.`;
  }
}

/** What a stub says in a legacy data directory, which has no notes. */
export function legacyHint(dataDir: string): string {
  return (
    `${dataDir} is a legacy data directory: its Agents and settings can't be changed any more. ` +
    'Run pero migrate <workspace> to move it to a workspace with notes, then edit them.'
  );
}
