import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModule } from '../agents/agents.module.js';
import { SKELETON_NOTES } from '../config/workspace-skeleton.js';
import { Definitions } from '../definitions/definitions.js';
import { HostConfigModule } from '../host-config/host-config.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { SettingsNotes } from '../settings-notes/settings-notes.service.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
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

  /** The text of `file` in the settings folder. */
  function read(file: string): string {
    return readFileSync(join(workspace, 'data', 'Settings', file), 'utf8');
  }

  /** The notes in `Agents/`, sorted. */
  function agentNotes(): string[] {
    return readdirSync(join(workspace, 'data', 'Settings', 'Agents')).sort();
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
        }),
        AgentsModule,
        ChannelsModule,
        WorkflowsModule,
      ],
    })
      .overrideProvider(ChannelTurns)
      .useValue(turns)
      .compile();
    await moduleRef.init();
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
    const coach = await moduleRef.get(Definitions).agent('coach');
    expect(coach).toMatchObject({
      name: 'coach',
      title: 'Coach',
      instructions: 'You coach.',
      workingDirectory: join(workspace, 'data'),
    });
  });

  it('sends General topics and direct chats to the main Agent', async () => {
    await adapter.deliver(inboundMessage(OWNER, { text: 'Hi' }));
    await adapter.deliver(inboundMessage(GROUP, { text: 'Hi' }));

    expect(answeredBy()).toEqual(['coach', 'coach']);
    expect(sentTexts()).toEqual([
      expect.stringMatching(/^This chat talks to Agent coach: claude/),
      expect.stringMatching(/^This chat talks to Agent coach: claude/),
    ]);
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
    await edit('Agents/Health.md', '---\ntopics: [Health, Running]\n---');
    await inTopic('6', 'Running');
    expect(answeredBy()).toEqual(['health']);

    await edit('Agents/Coach.md', '---\ntopics: Running\n---');
    await edit('Agents/Health.md', '---\ntopics: Health\n---');
    await inTopic('6', 'Running');
    expect(answeredBy()).toEqual(['health', 'coach']);
  });

  describe('a topic no Agent claims', () => {
    const TEMPLATE =
      '---\n# For new topics\nmodel: haiku # quick\n---\nYou help with this topic.\n';

    it("gets a note from the template, a welcome, and the note's answers", async () => {
      write('Agents/_Template.md', TEMPLATE);
      await adapter.emit(topicCreated(GROUP, '6', { title: 'Running' }));

      expect(read('Agents/Running.md')).toBe(
        '---\n# For new topics\nmodel: haiku # quick\ntopics:\n  - Running\n---\nYou help with this topic.\n',
      );
      expect(sentTexts()).toEqual([
        expect.stringMatching(
          /^This topic talks to Agent running: claude, model haiku/,
        ),
      ]);
      // No reload wait: it answers the next message.
      await inTopic('6', 'Running');
      expect(answeredBy()).toEqual(['running']);
      await expect(
        moduleRef.get(Definitions).agent('running'),
      ).resolves.toMatchObject({ instructions: 'You help with this topic.' });
      expect(sentTexts()).toHaveLength(1);
    });

    it('gets one note when its creation and first message race', async () => {
      await Promise.all([
        adapter.emit(topicCreated(GROUP, '6', { title: 'Running' })),
        inTopic('6', 'Running'),
        inTopic('6', 'Running'),
      ]);

      expect(agentNotes()).toEqual([
        'Coach.md',
        'Health.md',
        'Retired.md',
        'Running.md',
        'Sleep.md',
      ]);
      expect(read('Agents/Running.md')).toBe(
        '---\ntopics:\n  - Running\n---\n',
      );
      expect(sentTexts()).toEqual([
        expect.stringMatching(/^This topic talks to Agent running/),
      ]);
      expect(answeredBy()).toEqual(['running', 'running']);
    });

    it('gets a note on its next message when Pero knew it before', async () => {
      await inTopic('7', null);
      expect(sentTexts()).toEqual([
        expect.stringMatching(/^Pero doesn't know this topic's title yet/),
      ]);

      await inTopic('7', 'Running');
      expect(agentNotes()).toContain('Running.md');
      expect(answeredBy()).toEqual(['running']);
    });

    it('never overwrites a note, numbering the new one instead', async () => {
      // Named garden, from a subfolder, and a file that exists.
      write('Agents/Work/Garden.md', 'Mine.');
      write('Agents/Garden 2.md', 'Mine too.');
      await inTopic('6', 'Health?');
      await inTopic('7', 'Garden/');

      expect(read('Agents/Health.md')).toBe(
        '---\ntopics: Health\n---\nYou track health.',
      );
      expect(read('Agents/Health 2.md')).toBe(
        '---\ntopics:\n  - Health?\n---\n',
      );
      expect(read('Agents/Garden 3.md')).toBe(
        '---\ntopics:\n  - Garden/\n---\n',
      );
      expect(answeredBy()).toEqual(['health-2', 'garden-3']);
    });

    it('gets the main Agent, and no note, with new-topics: main-agent', async () => {
      await edit(
        'Pero.md',
        '---\nmain-agent: Coach\nnew-topics: main-agent\n---',
      );
      await adapter.emit(topicCreated(GROUP, '6', { title: 'Running' }));
      await inTopic('6', 'Running');
      await inTopic('7', null);

      expect(answeredBy()).toEqual(['coach', 'coach']);
      expect(agentNotes()).toEqual([
        'Coach.md',
        'Health.md',
        'Retired.md',
        'Sleep.md',
      ]);
    });
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

  it("writes the main Agent's note when a primary Channel needs it", async () => {
    await edit('Pero.md', '---\nmain-agent: Boss\n---');
    await adapter.deliver(inboundMessage(OWNER, { text: 'Hi' }));
    await adapter.deliver(inboundMessage(GROUP, { text: 'Hi' }));

    expect(read('Agents/Boss.md')).toBe(SKELETON_NOTES['Agents/Main.md']);
    expect(answeredBy()).toEqual(['boss', 'boss']);
    expect(sentTexts()).toEqual([
      expect.stringMatching(/^This chat talks to Agent boss: claude/),
      expect.stringMatching(/^This chat talks to Agent boss: claude/),
    ]);
  });

  it("keeps a main Agent's note that has errors, saying no one answers", async () => {
    await edit('Pero.md', '---\nmain-agent: Sleep\n---');
    await adapter.deliver(inboundMessage(OWNER, { text: 'Hi' }));

    expect(agentNotes()).toEqual([
      'Coach.md',
      'Health.md',
      'Retired.md',
      'Sleep.md',
    ]);
    expect(answeredBy()).toEqual([]);
    expect(sentTexts()).toEqual([
      'No one answers here: no note defines the main Agent, sleep. ' +
        'Add data/Settings/Agents/Sleep.md.',
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

  describe('a renamed topic', () => {
    it('stays with its Agent, whose note keeps its comments and body', async () => {
      await edit(
        'Agents/Health.md',
        '---\n# Mine\ntopics: [Health, Steps] # both\n---\n\nYou track health.\n',
      );
      await adapter.emit(topicCreated(GROUP, '5', { title: 'Health' }));
      await adapter.emit(topicRenamed(GROUP, '5', 'Fitness'));

      expect(read('Agents/Health.md')).toBe(
        '---\n# Mine\ntopics: [Fitness, Steps] # both\n---\n\nYou track health.\n',
      );
      // Messages still carry the title the topic was created with.
      await inTopic('5', 'Health');
      expect(answeredBy()).toEqual(['health']);
      expect(agentNotes()).not.toContain('Fitness.md');
    });

    it('keeps the old title too while another topic has it', async () => {
      await adapter.emit(topicCreated(GROUP, '5', { title: 'Health' }));
      await adapter.emit(topicCreated(GROUP, '6', { title: 'Health' }));
      await adapter.emit(topicRenamed(GROUP, '5', 'Fitness'));

      expect(read('Agents/Health.md')).toBe(
        '---\ntopics:\n  - Health\n  - Fitness\n---\nYou track health.',
      );
      await inTopic('5', 'Health');
      await inTopic('6', 'Health');
      expect(answeredBy()).toEqual(['health', 'health']);
    });

    it('moves to the Agent that claims its new title, leaving the note alone', async () => {
      await edit('Agents/Coach.md', '---\ntopics: Coaching\n---');
      await adapter.emit(topicCreated(GROUP, '5', { title: 'Health' }));
      await inTopic('5', 'Health');
      await adapter.emit(topicRenamed(GROUP, '5', 'Coaching'));
      await inTopic('5', 'Health');

      expect(read('Agents/Health.md')).toBe(
        '---\ntopics: Health\n---\nYou track health.',
      );
      expect(answeredBy()).toEqual(['health', 'coach']);
    });
  });
});
