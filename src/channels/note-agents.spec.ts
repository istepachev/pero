import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { Definitions } from '../definitions/definitions.js';
import { FileDefinitions } from '../definitions/file-definitions.js';
import { HostConfigModule } from '../host-config/host-config.module.js';
import { Agent } from '../persistence/entities/agent.entity.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import {
  SETTINGS_ID,
  Settings,
} from '../persistence/entities/settings.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsNotes } from '../settings-notes/settings-notes.service.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { AllowedChatsService } from './allowed-chats.service.js';
import { ChannelRouter } from './channel-router.js';
import { ChannelTurns } from './channel-stages.js';
import { ChannelsModule } from './channels.module.js';
import { ChannelsService } from './channels.service.js';
import {
  FakeChannelAdapter,
  groupChat,
  inboundMessage,
  privateChat,
  topicCreated,
} from './testing/fake-channel-adapter.js';

const GROUP = groupChat('-1009007199254740993', 'Household');
const OWNER = privateChat('1234');

/*
 * In a workspace, Agents come from notes, while Channels still point at
 * Agent rows until plan step 8.2: a row only anchors a Channel to the
 * Agent a note of that name defines.
 */
describe('Agents from notes in a workspace', () => {
  let workspace: string;
  let moduleRef: TestingModule;
  let ds: DataSource;
  let adapter: FakeChannelAdapter;
  /** Each write gets a later modification time, whatever the clock. */
  let clock: number;
  const turns = {
    handle: vi.fn(() => Promise.resolve()),
    drain: vi.fn(() => Promise.resolve()),
  };

  function write(file: string, text: string) {
    const path = join(workspace, 'data', 'Settings', file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    clock += 1_000;
    utimesSync(path, new Date(clock), new Date(clock));
  }

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'pero-note-agents-'));
    mkdirSync(join(workspace, '.pero'));
    clock = Date.parse('2026-01-01T00:00:00Z');
    write('Pero.md', '---\nmain-agent: Coach\n---\nBe brief.');
    write('Agents/Coach.md', 'You coach.');
    write('Agents/Health.md', '---\ntopics: Health\n---\nYou track health.');
    write('Agents/Retired.md', '---\nenabled: false\n---');
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({
          database: join(workspace, '.pero', 'pero.sqlite'),
        }),
        HostConfigModule.forRoot({
          file: join(workspace, '.pero', 'config.yaml'),
          workspace,
          base: workspace,
        }),
        SettingsModule,
        AgentsModule,
        ChannelsModule,
        WorkflowsModule,
      ],
    })
      .overrideProvider(ChannelTurns)
      .useValue(turns)
      .compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    const allowedChats = moduleRef.get(AllowedChatsService);
    for (const chat of [GROUP, OWNER]) {
      await allowedChats.allow({
        integrationKind: 'telegram',
        chatKey: chat.key,
        kind: chat.kind,
        title: chat.title,
      });
    }
    adapter = new FakeChannelAdapter();
    await moduleRef.get(ChannelRouter).connect(adapter);
  });

  afterEach(async () => {
    await moduleRef.close();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
  });

  function rows(): Promise<string[]> {
    return ds
      .getRepository(Agent)
      .find({ order: { id: 'ASC' } })
      .then((agents) => agents.map((agent) => agent.name));
  }

  function answeredBy(): string[] {
    return turns.handle.mock.calls.map(
      (call) =>
        (call as unknown as [{ agent: { name: string } }])[0].agent.name,
    );
  }

  it('reads the Agents from the notes', async () => {
    expect(moduleRef.get(Definitions)).toBe(moduleRef.get(FileDefinitions));
    const coach = await moduleRef.get(Definitions).agent('coach');
    expect(coach).toMatchObject({
      name: 'coach',
      title: 'Coach',
      instructions: 'You coach.',
      workingDirectory: join(workspace, 'data'),
    });
  });

  it('anchors a primary Channel to the main Agent Pero.md names', async () => {
    await adapter.deliver(inboundMessage(OWNER, { text: 'Hi' }));

    expect(await rows()).toEqual(['coach']);
    const settings = await ds
      .getRepository(Settings)
      .findOneByOrFail({ id: SETTINGS_ID });
    expect(settings.mainAgentId).toBeNull();
    expect(adapter.sent.map((sent) => sent.message.text)).toEqual([
      expect.stringMatching(/^This chat talks to Agent coach: claude/),
    ]);
    expect(answeredBy()).toEqual(['coach']);
  });

  it('leaves a topic no note defines unanswered, until a note does', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    await adapter.emit(topicCreated(GROUP, '7', { title: 'Garden' }));
    await adapter.deliver(inboundMessage(GROUP, { topic: '7', text: 'Hi' }));

    expect(await rows()).toEqual(['garden']);
    expect(adapter.sent).toEqual([]);
    expect(turns.handle).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Agent garden has no note; add Agents/garden.md to the settings folder',
      ),
    );

    write('Agents/Garden.md', 'You garden.');
    await moduleRef.get(SettingsNotes).rescan();
    await adapter.deliver(inboundMessage(GROUP, { topic: '7', text: 'Hi' }));
    expect(answeredBy()).toEqual(['garden']);
  });

  it('assigns a Channel to an Agent only a note defines', async () => {
    await adapter.emit(topicCreated(GROUP, '7', { title: 'Health' }));
    const channel = await ds
      .getRepository(Channel)
      .findOneByOrFail({ externalKey: `${GROUP.key}:7` });

    await expect(
      moduleRef.get(ChannelsService).assign(channel.id, 'health'),
    ).resolves.toEqual({ from: 'health', to: 'health', alreadyAssigned: true });

    await expect(
      moduleRef.get(ChannelsService).assign(channel.id, 'coach'),
    ).resolves.toEqual({ from: 'health', to: 'coach', alreadyAssigned: false });
    expect(await rows()).toEqual(['health', 'coach']);
    await adapter.deliver(inboundMessage(GROUP, { topic: '7', text: 'Hi' }));
    expect(answeredBy()).toEqual(['coach']);

    await expect(
      moduleRef.get(ChannelsService).assign(channel.id, 'retired'),
    ).rejects.toThrow(
      'Agent retired is disabled; enable it first (enabled: true in its note)',
    );
    await expect(
      moduleRef.get(ChannelsService).assign(channel.id, 'nobody'),
    ).rejects.toThrow('No Agent named nobody');
  });

  it('lets a Workflow use an Agent only a note defines', async () => {
    const workflows = moduleRef.get(WorkflowsService);
    await expect(
      workflows.create({
        name: 'report',
        agent: 'Health',
        inputTemplate: 'Report.',
      }),
    ).resolves.toMatchObject({ agentName: 'health' });
    await expect(
      workflows.create({
        name: 'old',
        agent: 'retired',
        inputTemplate: 'Report.',
      }),
    ).rejects.toThrow(
      'Agent retired is disabled; enable it first (enabled: true in its note)',
    );
  });
});
