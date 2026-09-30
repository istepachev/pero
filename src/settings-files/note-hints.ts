import { join, posix, relative } from 'node:path';
import { slugify } from '../config/slug.js';
import { NOTE_FOLDERS, noteIdentity, PERO_NOTE } from './note-files.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/*
 * What the commands that changed Agents, Workflows, their Triggers,
 * settings, and which Agent answers in a Channel say now that notes hold
 * them: the file to edit instead. They stay as such stubs for one release.
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
  return findNote(files, 'agent', name);
}

/**
 * The note that defines the Workflow named `name`, in any case or as its
 * title, among `files`, the paths in the settings folder; null if none.
 */
export function findWorkflowNote(
  files: readonly string[],
  name: string,
): string | null {
  return findNote(files, 'workflow', name);
}

function findNote(
  files: readonly string[],
  kind: keyof typeof NOTE_FOLDERS,
  name: string,
): string | null {
  const wanted = slugify(name) ?? name.toLowerCase();
  for (const file of files) {
    const found = noteIdentity(file);
    if (
      found.ok &&
      found.identity.kind === kind &&
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

/** A command that changed a Workflow. */
export type WorkflowAction =
  'create' | 'edit' | 'enable' | 'disable' | 'notify' | 'stop-notifying';

/**
 * What to edit instead of `pero workflows <action> <name>`, given `note`,
 * the path of the Workflow's note in the settings folder, or null.
 */
export function workflowHint(
  action: WorkflowAction,
  name: string,
  note: string | null,
  files: ConfigurationFiles,
): string {
  const shown = (file: string) =>
    shownPath(files.workspace, join(files.settingsFolder, file));
  const prefix = 'Workflows are configured in notes now';
  const add = `add ${shown(posix.join(NOTE_FOLDERS.workflow, `${name}.md`))}: its text is what each run asks the Agent, and hour and channel say when it runs and where it posts`;
  if (note === null) {
    return action === 'create'
      ? `${prefix}: ${add}.`
      : `${prefix}, and no note is named ${name}: ${add}.`;
  }
  const seen = "pero channels ls shows each topic's title";
  switch (action) {
    case 'create':
      return `${prefix}, and ${shown(note)} already defines ${name}; edit it there.`;
    case 'edit':
      return `${prefix}: edit ${shown(note)}.`;
    case 'enable':
      return `${prefix}: set enabled: true in ${shown(note)}.`;
    case 'disable':
      return `${prefix}: set enabled: false in ${shown(note)}, which stops its schedule; pero workflows run still runs it.`;
    case 'notify':
      return `${prefix}: add the topic's title to channel in ${shown(note)}; ${seen}.`;
    case 'stop-notifying':
      return `${prefix}: take the topic's title out of channel in ${shown(note)}; ${seen}.`;
  }
}

/** A command that listed or changed the Triggers that start Workflows. */
export type TriggerAction = 'list' | 'add' | 'remove' | 'enable' | 'disable';

/**
 * What to do instead of `pero triggers <action>`. For `add`, `workflow` is
 * the Workflow named and `note` the path of its note in the settings
 * folder, or null.
 */
export function triggerHint(
  action: TriggerAction,
  workflow: string | null,
  note: string | null,
  files: ConfigurationFiles,
): string {
  const shown = (file: string) =>
    shownPath(files.workspace, join(files.settingsFolder, file));
  const prefix = 'Workflows run on the schedules their notes set now';
  const byHand = 'any Workflow runs by hand with pero workflows run <name>';
  const listed = "pero workflows ls shows each Workflow's note";
  switch (action) {
    case 'list':
      return `${prefix}: pero workflows ls shows each schedule and its next run.`;
    case 'add':
      if (note === null) {
        const add = shown(posix.join(NOTE_FOLDERS.workflow, `${workflow}.md`));
        return `${prefix}, and no note is named ${workflow}: add ${add} with hour, day, and minute, or cron; ${byHand}.`;
      }
      return `${prefix}: set hour, day, and minute, or cron, in ${shown(note)}; ${byHand}.`;
    case 'remove':
    case 'disable':
      return `${prefix}: set trigger: manual in the Workflow's note to stop its schedule; ${listed}.`;
    case 'enable':
      return `${prefix}: set trigger: schedule and enabled: true in the Workflow's note; ${listed}.`;
  }
}

/** A command that changed which Agent answers in a Channel. */
export type ChannelAction = 'assign' | 'enable' | 'disable';

/**
 * What to edit instead of `pero channels <action>`. For `assign`, `agent`
 * is the Agent named and `note` the path of its note in the settings
 * folder, or null.
 */
export function channelHint(
  action: ChannelAction,
  agent: string | null,
  note: string | null,
  files: ConfigurationFiles,
): string {
  const shown = (file: string) =>
    shownPath(files.workspace, join(files.settingsFolder, file));
  const prefix = "Topics are routed by the Agent notes' topics now";
  const seen =
    "pero channels ls shows each topic's title and who answers there";
  switch (action) {
    case 'assign':
      if (note === null) {
        const add = shown(posix.join(NOTE_FOLDERS.agent, `${agent}.md`));
        return `${prefix}, and no note is named ${agent}: add ${add} with the topic's title in its topics; ${seen}.`;
      }
      return `${prefix}: add the topic's title to topics in ${shown(note)}; ${seen}.`;
    case 'enable':
      return `${prefix}, so a Channel isn't enabled on its own: set enabled: true in the note of the Agent that claims the topic, or add its title to an Agent's topics; ${seen}.`;
    case 'disable':
      return `${prefix}, so a Channel isn't disabled on its own: set enabled: false in the note of the Agent that answers there, or take the title out of its topics; ${seen}.`;
  }
}

/** What a stub says in a legacy data directory, which has no notes. */
export function legacyHint(dataDir: string): string {
  return (
    `${dataDir} is a legacy data directory, which has no Agents any more. ` +
    'Run pero migrate <workspace> to move it to a workspace with notes, then edit them.'
  );
}
