import { describe, expect, it } from 'vitest';
import {
  agentHint,
  channelHint,
  findAgentNote,
  findWorkflowNote,
  legacyHint,
  SETTING_HOMES,
  settingHint,
  shownPath,
  triggerHint,
  workflowHint,
} from './note-hints.js';

const FILES = {
  workspace: '/home/me/workspace',
  configFile: '/home/me/workspace/.pero/config.yaml',
  settingsFolder: '/home/me/workspace/data/Settings',
};

describe('note hints', () => {
  it('shows paths inside the workspace relative to it', () => {
    expect(shownPath(FILES.workspace, FILES.configFile)).toBe(
      '.pero/config.yaml',
    );
    expect(shownPath(FILES.workspace, '/srv/vault/Settings/Pero.md')).toBe(
      '/srv/vault/Settings/Pero.md',
    );
  });

  it('finds an Agent note by name or title, in subfolders too', () => {
    const files = [
      'Pero.md',
      'Agents/Main.md',
      'Agents/Home/Health Coach.md',
      'Workflows/Health Coach.md',
    ];
    expect(findAgentNote(files, 'health-coach')).toBe(
      'Agents/Home/Health Coach.md',
    );
    expect(findAgentNote(files, 'Health Coach')).toBe(
      'Agents/Home/Health Coach.md',
    );
    expect(findAgentNote(files, 'MAIN')).toBe('Agents/Main.md');
    expect(findAgentNote(files, 'coach')).toBeNull();
  });

  it('names the note to edit instead of each Agent command', () => {
    const note = 'Agents/Home/Coach.md';
    expect(agentHint('edit', 'coach', note, FILES)).toBe(
      'Agents are configured in notes now: edit data/Settings/Agents/Home/Coach.md.',
    );
    expect(agentHint('disable', 'coach', note, FILES)).toBe(
      'Agents are configured in notes now: set enabled: false in data/Settings/Agents/Home/Coach.md.',
    );
    expect(agentHint('enable', 'coach', note, FILES)).toBe(
      'Agents are configured in notes now: set enabled: true in data/Settings/Agents/Home/Coach.md.',
    );
    expect(agentHint('create', 'coach', note, FILES)).toBe(
      'Agents are configured in notes now, and data/Settings/Agents/Home/Coach.md already defines coach; edit it there.',
    );
    expect(agentHint('create', 'Coach', null, FILES)).toBe(
      'Agents are configured in notes now: add data/Settings/Agents/Coach.md (Agents/_Template.md shows the properties).',
    );
    expect(agentHint('edit', 'coach', null, FILES)).toBe(
      'Agents are configured in notes now, and no note is named coach: add data/Settings/Agents/coach.md (Agents/_Template.md shows the properties).',
    );
  });

  it('finds a Workflow note by name or title, in subfolders too', () => {
    const files = [
      'Agents/Weekly Report.md',
      'Workflows/Health/Weekly Report.md',
    ];
    expect(findWorkflowNote(files, 'weekly-report')).toBe(
      'Workflows/Health/Weekly Report.md',
    );
    expect(findWorkflowNote(files, 'Weekly Report')).toBe(
      'Workflows/Health/Weekly Report.md',
    );
    expect(findWorkflowNote(files, 'report')).toBeNull();
  });

  it('names the note to edit instead of each Workflow command', () => {
    const note = 'Workflows/Report.md';
    const prefix = 'Workflows are configured in notes now';
    expect(workflowHint('edit', 'report', note, FILES)).toBe(
      `${prefix}: edit data/Settings/Workflows/Report.md.`,
    );
    expect(workflowHint('enable', 'report', note, FILES)).toBe(
      `${prefix}: set enabled: true in data/Settings/Workflows/Report.md.`,
    );
    expect(workflowHint('disable', 'report', note, FILES)).toBe(
      `${prefix}: set enabled: false in data/Settings/Workflows/Report.md, which stops its schedule; pero workflows run still runs it.`,
    );
    expect(workflowHint('notify', 'report', note, FILES)).toBe(
      `${prefix}: add the topic's title to channel in data/Settings/Workflows/Report.md; pero channels ls shows each topic's title.`,
    );
    expect(workflowHint('stop-notifying', 'report', note, FILES)).toBe(
      `${prefix}: take the topic's title out of channel in data/Settings/Workflows/Report.md; pero channels ls shows each topic's title.`,
    );
    expect(workflowHint('create', 'report', note, FILES)).toBe(
      `${prefix}, and data/Settings/Workflows/Report.md already defines report; edit it there.`,
    );
    expect(workflowHint('create', 'Brief', null, FILES)).toBe(
      `${prefix}: add data/Settings/Workflows/Brief.md: its text is what each run asks the Agent, and hour and channel say when it runs and where it posts.`,
    );
    expect(workflowHint('notify', 'brief', null, FILES)).toMatch(
      new RegExp(
        `^${prefix}, and no note is named brief: add data/Settings/Workflows/brief.md: `,
      ),
    );
  });

  it('says what to do instead of each Trigger command', () => {
    const prefix = 'Workflows run on the schedules their notes set now';
    expect(triggerHint('list', null, null, FILES)).toBe(
      `${prefix}: pero workflows ls shows each schedule and its next run.`,
    );
    expect(triggerHint('add', 'report', 'Workflows/Report.md', FILES)).toBe(
      `${prefix}: set hour, day, and minute, or cron, in data/Settings/Workflows/Report.md; any Workflow runs by hand with pero workflows run <name>.`,
    );
    expect(triggerHint('add', 'brief', null, FILES)).toBe(
      `${prefix}, and no note is named brief: add data/Settings/Workflows/brief.md with hour, day, and minute, or cron; any Workflow runs by hand with pero workflows run <name>.`,
    );
    expect(triggerHint('disable', null, null, FILES)).toBe(
      `${prefix}: set trigger: manual in the Workflow's note to stop its schedule; pero workflows ls shows each Workflow's note.`,
    );
    expect(triggerHint('remove', null, null, FILES)).toBe(
      triggerHint('disable', null, null, FILES),
    );
    expect(triggerHint('enable', null, null, FILES)).toBe(
      `${prefix}: set trigger: schedule and enabled: true in the Workflow's note; pero workflows ls shows each Workflow's note.`,
    );
  });

  it('names the note to edit instead of each Channel command', () => {
    const seen =
      "pero channels ls shows each topic's title and who answers there.";
    expect(channelHint('assign', 'coach', 'Agents/Home/Coach.md', FILES)).toBe(
      "Topics are routed by the Agent notes' topics now: add the topic's " +
        `title to topics in data/Settings/Agents/Home/Coach.md; ${seen}`,
    );
    expect(channelHint('assign', 'chef', null, FILES)).toBe(
      "Topics are routed by the Agent notes' topics now, and no note is " +
        "named chef: add data/Settings/Agents/chef.md with the topic's " +
        `title in its topics; ${seen}`,
    );
    expect(channelHint('disable', null, null, FILES)).toMatch(
      /so a Channel isn't disabled on its own: set enabled: false in the note of the Agent that answers there/,
    );
    expect(channelHint('enable', null, null, FILES)).toMatch(
      /so a Channel isn't enabled on its own: set enabled: true in the note of the Agent that claims the topic/,
    );
  });

  it('names the file and property of each setting', () => {
    expect(settingHint(SETTING_HOMES['claude.model']!, FILES)).toBe(
      'Settings are in notes now: set claude-model in data/Settings/Pero.md.',
    );
    expect(settingHint(SETTING_HOMES['default-permissions']!, FILES)).toBe(
      'Settings are in notes now: set permissions in data/Settings/Pero.md.',
    );
    expect(settingHint(SETTING_HOMES['shared-instructions']!, FILES)).toBe(
      "Settings are in notes now: edit the body of data/Settings/Pero.md, which goes before each Agent's own instructions.",
    );
    expect(
      settingHint(SETTING_HOMES['default-working-directory']!, FILES),
    ).toBe(
      'The data folder is set in config.yaml now: set data in .pero/config.yaml, then restart Pero.',
    );
    expect(SETTING_HOMES['telegram-bot-token']).toBeUndefined();
  });

  it('says to migrate a legacy data directory', () => {
    expect(legacyHint('/home/me/.pero')).toBe(
      '/home/me/.pero is a legacy data directory, which has no Agents any more. Run pero migrate <workspace> to move it to a workspace with notes, then edit them.',
    );
  });
});
