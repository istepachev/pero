import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { Definitions } from '../definitions/definitions.js';
import { FileDefinitions } from '../definitions/file-definitions.js';
import { HostConfigModule } from '../host-config/host-config.module.js';
import { Agent } from '../persistence/entities/agent.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SettingsNotes } from '../settings-notes/settings-notes.service.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { AllowedChatsService } from './allowed-chats.service.js';
import { ChannelRouter } from './channel-router.js';
import { ChannelTurns } from './channel-stages.js';
import { ChannelsModule } from './channels.module.js';
import {
  FakeChannelAdapter,
  groupChat,
  inboundMessage,
  privateChat,
  topicCreated,
  topicRenamed,
} from './testing/fake-channel-adapter.js';

const GROUP = groupChat('-1009007199254740993', 'Household');
const OWNER = privateChat('1234');

/*
 * In a workspace, Agents come from notes, and so does which one answers
 * where: a primary Channel gets the main Agent, and a topic the Agent
 * whose topics claims its title, chosen on every message.
 */
describe('Topic routing by notes in a workspace', () => {
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

  /** Writes `file` and has Pero read the notes again. */
  async function edit(file: string, text: string) {
    write(file, text);
    await moduleRef.get(SettingsNotes).rescan();
  }

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'pero-note-agents-'));
    mkdirSync(join(workspace, '.pero'));
    clock = Date.parse('2026-01-01T00:00:00Z');
    write('Pero.md', '---\nmain-agent: Coach\n---\nBe brief.');
    write('Agents/Coach.md', 'You coach.');
    write('Agents/Health.md', '---\ntopics: Health\n---\nYou track health.');
    write('Agents/Retired.md', '---\ntopics: Garden\nenabled: false\n---');
    // Broken since Pero started, so it never loaded.
    write('Agents/Sleep.md', '---\ntopics: Sleep\nmodle: x\n---');
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

  function answeredBy(): string[] {
    return turns.handle.mock.calls.map(
      (call) =>
        (call as unknown as [{ agent: { name: string } }])[0].agent.name,
    );
  }

  function sentTexts(): string[] {
    return adapter.sent.map((sent) => sent.message.text);
  }

  /** A message in topic `topic` of the group, titled `title`. */
  function inTopic(topic: string, title: string | null) {
    return adapter.deliver(inboundMessage(GROUP, { topic, title, text: 'Hi' }));
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

  it('sends General topics and direct chats to the main Agent, and stores no Agent', async () => {
    await adapter.deliver(inboundMessage(OWNER, { text: 'Hi' }));
    await adapter.deliver(inboundMessage(GROUP, { text: 'Hi' }));

    expect(answeredBy()).toEqual(['coach', 'coach']);
    expect(sentTexts()).toEqual([
      expect.stringMatching(/^This chat talks to Agent coach: claude/),
      expect.stringMatching(/^This chat talks to Agent coach: claude/),
    ]);
    expect(await ds.getRepository(Agent).count()).toBe(0);
  });

  it('sends a topic to the Agent that claims its title', async () => {
    await adapter.emit(topicCreated(GROUP, '5', { title: 'health' }));
    await inTopic('5', 'health');

    expect(answeredBy()).toEqual(['health']);
    expect(sentTexts()).toEqual([
      expect.stringMatching(/^This topic talks to Agent health: claude/),
    ]);
  });

  it('moves a topic once another Agent claims its title', async () => {
    await inTopic('6', 'Running');
    expect(answeredBy()).toEqual([]);
    expect(sentTexts()).toEqual([
      'No Agent answers in this topic: none lists "Running" in its topics. ' +
        "Add it to an Agent note's topics, or create " +
        'data/Settings/Agents/Running.md with topics: [Running].',
    ]);

    await edit('Agents/Health.md', '---\ntopics: [Health, Running]\n---');
    await inTopic('6', 'Running');
    expect(answeredBy()).toEqual(['health']);

    await edit('Agents/Coach.md', '---\ntopics: Running\n---');
    await edit('Agents/Health.md', '---\ntopics: Health\n---');
    await inTopic('6', 'Running');
    expect(answeredBy()).toEqual(['health', 'coach']);
  });

  it('answers a topic claimed twice with neither, and says why once', async () => {
    await edit('Agents/Runner.md', '---\ntopics: Health\n---');
    await inTopic('5', 'Health');
    await inTopic('5', 'Health');

    expect(answeredBy()).toEqual([]);
    expect(sentTexts()).toEqual([
      'No one answers in this topic: data/Settings/Agents/Health.md and ' +
        'data/Settings/Agents/Runner.md claim "Health" in their topics. ' +
        'Keep it in only one of them.',
    ]);

    // Once it is answered again, a new problem is told again.
    await edit('Agents/Runner.md', 'You run.');
    await inTopic('5', 'Health');
    await edit('Agents/Runner.md', '---\ntopics: Health\n---');
    await inTopic('5', 'Health');
    expect(answeredBy()).toEqual(['health']);
    expect(sentTexts()).toHaveLength(2);
  });

  it("silences a disabled Agent's topics, saying so once", async () => {
    await inTopic('8', 'Garden');
    await inTopic('8', 'Garden');

    expect(answeredBy()).toEqual([]);
    expect(sentTexts()).toEqual([
      'Agent retired is disabled, so no one answers here. To turn it back ' +
        'on, set enabled: true in data/Settings/Agents/Retired.md.',
    ]);
  });

  it('names the note that claims a topic but never loaded', async () => {
    await inTopic('9', 'Sleep');

    expect(answeredBy()).toEqual([]);
    expect(sentTexts()).toEqual([
      expect.stringContaining(
        'data/Settings/Agents/Sleep.md claims "Sleep" but has errors',
      ),
    ]);
  });

  it('sends an unclaimed topic to the main Agent with new-topics: main-agent', async () => {
    await edit(
      'Pero.md',
      '---\nmain-agent: Coach\nnew-topics: main-agent\n---',
    );
    await inTopic('6', 'Running');
    await inTopic('7', null);

    expect(answeredBy()).toEqual(['coach', 'coach']);
  });

  it('says when no note defines the main Agent', async () => {
    await edit('Pero.md', '---\nmain-agent: Boss\n---');
    await adapter.deliver(inboundMessage(OWNER, { text: 'Hi' }));

    expect(answeredBy()).toEqual([]);
    expect(sentTexts()).toEqual([
      'No one answers here: no note defines the main Agent, boss. ' +
        'Add data/Settings/Agents/Boss.md.',
    ]);
  });

  it('routes a topic once a message tells its title', async () => {
    await inTopic('5', null);
    expect(answeredBy()).toEqual([]);
    expect(sentTexts()).toEqual([
      expect.stringMatching(/^Pero doesn't know this topic's title yet/),
    ]);

    await inTopic('5', 'Health');
    expect(answeredBy()).toEqual(['health']);
  });

  it('follows a renamed topic to the Agent claiming its new title', async () => {
    await adapter.emit(topicCreated(GROUP, '5', { title: 'Health' }));
    await inTopic('5', 'Health');
    await adapter.emit(topicRenamed(GROUP, '5', 'Coaching'));
    await edit('Agents/Coach.md', '---\ntopics: Coaching\n---');
    // Messages still carry the title the topic was created with.
    await inTopic('5', 'Health');

    expect(answeredBy()).toEqual(['health', 'coach']);
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
