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
import {
  CHANNEL_TEMPLATE_NOTE,
  SKELETON_NOTES,
} from '../config/workspace-skeleton.js';
import { HostConfigModule } from '../host-config/host-config.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { noteFromTemplate } from '../system-files/note-writer.js';
import { Definitions } from '../system/definitions.js';
import { SystemNotes } from '../system/system-notes.service.js';
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
  chatMigrated,
  topicCreated,
  topicRenamed,
} from './testing/fake-channel-adapter.js';

const GROUP = groupChat('-1009007199254740993', 'Household');
const OWNER = privateChat('1234');

/** The `channel-id` of topic `topic` of the group. */
const idOf = (topic: string) => `telegram:${GROUP.key}:${topic}`;

/*
 * In a workspace, how Pero answers in each Channel comes from notes: a
 * primary Channel uses Default.md, and a topic the note bound to it by
 * `channel-id`, which Pero writes, or binds, the first time it needs one.
 */
describe('Channel notes in a workspace', () => {
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
    const path = join(workspace, 'data', 'System', file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    clock += 1_000;
    utimesSync(path, new Date(clock), new Date(clock));
  }

  /** The text of `file` in the system folder. */
  function read(file: string): string {
    return readFileSync(join(workspace, 'data', 'System', file), 'utf8');
  }

  /** The notes in `Channels/`, sorted. */
  function channelNotes(): string[] {
    return readdirSync(join(workspace, 'data', 'System', 'Channels')).sort();
  }

  /** Writes `file` and has Pero read the notes again. */
  async function edit(file: string, text: string) {
    write(file, text);
    await moduleRef.get(SystemNotes).rescan();
  }

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'pero-note-channels-'));
    mkdirSync(join(workspace, '.pero'));
    clock = Date.parse('2026-01-01T00:00:00Z');
    write('Persona.md', 'You are calm.');
    write('Channels/Default.md', 'You coach.');
    write('Channels/Health.md', 'You track health.');
    write('Channels/Retired.md', '---\nenabled: false\n---');
    // Broken since Pero started, so it never loaded.
    write('Channels/Sleep.md', '---\nmodle: x\n---');
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
      (call) => (call as unknown as [{ note: { name: string } }])[0].note.name,
    );
  }

  function sentTexts(): string[] {
    return adapter.sent.map((sent) => sent.message.text);
  }

  /** A message in topic `topic` of the group, titled `title`. */
  function inTopic(topic: string, title: string | null) {
    return adapter.deliver(inboundMessage(GROUP, { topic, title, text: 'Hi' }));
  }

  it('reads the Channel notes', async () => {
    expect(moduleRef.get(Definitions).channelNote('default')).toMatchObject({
      name: 'default',
      title: 'Default',
      instructions: 'You coach.',
      workingDirectory: workspace,
    });
  });

  describe('Default.md', () => {
    it('answers General topics and direct chats', async () => {
      await adapter.deliver(inboundMessage(OWNER, { text: 'Hi' }));
      await adapter.deliver(inboundMessage(GROUP, { text: 'Hi' }));

      expect(answeredBy()).toEqual(['default', 'default']);
      expect(sentTexts()).toEqual([
        expect.stringMatching(/^Pero answers in this chat with claude/),
        expect.stringMatching(/^Pero answers in this chat with claude/),
      ]);
    });

    it('is written again when a primary Channel finds none', async () => {
      rmSync(join(workspace, 'data', 'System', 'Channels', 'Default.md'));
      await moduleRef.get(SystemNotes).rescan();
      await adapter.deliver(inboundMessage(OWNER, { text: 'Hi' }));

      expect(read('Channels/Default.md')).toBe(
        SKELETON_NOTES['Channels/Default.md'],
      );
      expect(answeredBy()).toEqual(['default']);
    });

    it('keeps answering from its last good version while it has errors', async () => {
      await edit('Channels/Default.md', '---\nchannel-id: telegram:1\n---');
      // A second version with the error, so it is no longer the last good one.
      await moduleRef.get(SystemNotes).rescan();
      await adapter.deliver(inboundMessage(OWNER, { text: 'Hi' }));

      expect(answeredBy()).toEqual(['default']);
    });
  });

  describe('a topic without a note', () => {
    const TEMPLATE =
      '---\n# For new topics\nmodel: haiku # quick\n---\nYou help with this topic.\n';

    it("gets one from Pero's template, bound to it, with a welcome", async () => {
      await adapter.emit(topicCreated(GROUP, '6', { title: 'Running' }));

      expect(read('Channels/Running.md')).toBe(
        noteFromTemplate(CHANNEL_TEMPLATE_NOTE, idOf('6')).text,
      );
      expect(sentTexts()).toEqual([
        expect.stringMatching(
          /^Pero answers in this topic with claude, default model, .*data\/System\/Channels\/Running\.md/,
        ),
      ]);
      // No reload wait: it answers the next message.
      await inTopic('6', 'Running');
      expect(answeredBy()).toEqual(['running']);
      expect(sentTexts()).toHaveLength(1);
    });

    it('gets one from _Template.md when there is one', async () => {
      write('Channels/_Template.md', TEMPLATE);
      await adapter.emit(topicCreated(GROUP, '6', { title: 'Running' }));

      expect(read('Channels/Running.md')).toBe(
        `---\n# For new topics\nmodel: haiku # quick\nchannel-id: ${idOf('6')}\n---\nYou help with this topic.\n`,
      );
      expect(sentTexts()).toEqual([
        expect.stringMatching(/^Pero answers in this topic with claude, model haiku/),
      ]);
      expect(moduleRef.get(Definitions).channelNote('running')).toMatchObject({
        instructions: 'You help with this topic.',
        channelId: idOf('6'),
      });
    });

    it('gets one note when its creation and first message race', async () => {
      await Promise.all([
        adapter.emit(topicCreated(GROUP, '6', { title: 'Running' })),
        inTopic('6', 'Running'),
        inTopic('6', 'Running'),
      ]);

      expect(channelNotes()).toEqual([
        'Default.md',
        'Health.md',
        'Retired.md',
        'Running.md',
        'Sleep.md',
      ]);
      expect(sentTexts()).toEqual([
        expect.stringMatching(/^Pero answers in this topic/),
      ]);
      expect(answeredBy()).toEqual(['running', 'running']);
    });

    it('gets one on its next message once Pero learns its title', async () => {
      await inTopic('7', null);
      expect(sentTexts()).toEqual([
        expect.stringMatching(/^Pero doesn't know this topic's title yet/),
      ]);

      await inTopic('7', 'Running');
      expect(channelNotes()).toContain('Running.md');
      expect(answeredBy()).toEqual(['running']);
    });

    it('takes a note of its title that is bound to no Channel, keeping its text', async () => {
      await adapter.emit(topicCreated(GROUP, '5', { title: 'health' }));
      await inTopic('5', 'health');

      expect(read('Channels/Health.md')).toBe(
        `---\nchannel-id: ${idOf('5')}\n---\nYou track health.`,
      );
      expect(answeredBy()).toEqual(['health']);
      expect(sentTexts()).toEqual([
        expect.stringMatching(/^Pero answers in this topic with claude/),
      ]);
    });

    it('never takes a note bound to another Channel, numbering its own', async () => {
      await inTopic('5', 'Health');
      await inTopic('6', 'Health?');

      expect(read('Channels/Health 2.md')).toBe(
        noteFromTemplate(CHANNEL_TEMPLATE_NOTE, idOf('6')).text,
      );
      expect(answeredBy()).toEqual(['health', 'health-2']);
    });
  });

  describe('a renamed topic', () => {
    it('keeps its note, whose file keeps its name', async () => {
      await adapter.emit(topicCreated(GROUP, '5', { title: 'Health' }));
      await adapter.emit(topicRenamed(GROUP, '5', 'Fitness'));
      await inTopic('5', 'Fitness');

      expect(read('Channels/Health.md')).toContain('You track health.');
      expect(channelNotes()).not.toContain('Fitness.md');
      expect(answeredBy()).toEqual(['health']);
    });

    it('keeps its note when the owner renames the file', async () => {
      await inTopic('5', 'Health');
      const text = read('Channels/Health.md');
      rmSync(join(workspace, 'data', 'System', 'Channels', 'Health.md'));
      await edit('Channels/Wellbeing.md', text);
      await inTopic('5', 'Health');

      expect(answeredBy()).toEqual(['health', 'wellbeing']);
      expect(channelNotes()).not.toContain('Health.md');
    });
  });

  it("follows a group's new chat ID in its notes", async () => {
    write(
      'Channels/Health.md',
      `---\nchannel-id: ${idOf('5')}\n---\nYou track health.`,
    );
    await adapter.deliver(inboundMessage(GROUP, { text: 'Hi' }));
    await adapter.emit(chatMigrated(GROUP, '-100555'));

    expect(read('Channels/Health.md')).toBe(
      '---\nchannel-id: telegram:-100555:5\n---\nYou track health.',
    );
  });

  it("silences a disabled note's Channel, saying so once", async () => {
    await inTopic('8', 'Retired');
    await inTopic('8', 'Retired');

    expect(answeredBy()).toEqual([]);
    expect(sentTexts()).toEqual([
      "Pero doesn't answer here: data/System/Channels/Retired.md sets " +
        'enabled: false. To turn it back on, set enabled: true there.',
    ]);
  });

  it('names the note of a Channel that never loaded', async () => {
    await inTopic('9', 'Sleep');

    expect(answeredBy()).toEqual([]);
    expect(sentTexts()).toEqual([
      expect.stringContaining(
        "data/System/Channels/Sleep.md is this Channel's note but has errors",
      ),
    ]);
  });

  it('says why no one answers when two notes are bound to one Channel', async () => {
    await inTopic('5', 'Health');
    await edit('Channels/Other.md', `---\nchannel-id: ${idOf('5')}\n---`);
    await inTopic('5', 'Health');

    expect(answeredBy()).toEqual(['health']);
    expect(sentTexts().at(-1)).toMatch(
      /^Pero doesn't answer here yet: data\/System\/Channels\/Health\.md and data\/System\/Channels\/Other\.md are this Channel's note/,
    );
  });
});
