import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AllowedChatsService } from '../channels/allowed-chats.service.js';
import { ChannelRouter } from '../channels/channel-router.js';
import { ChannelsModule } from '../channels/channels.module.js';
import type { InboundChannel } from '../channels/channel-adapter.js';
import {
  FakeChannelAdapter,
  groupChat,
  inboundChannel,
  privateChat,
} from '../channels/testing/fake-channel-adapter.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { Message } from '../persistence/entities/message.entity.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AGENT_RUNTIMES } from '../runtimes/agent-runtimes.js';
import { FakeAgentRuntime } from '../runtimes/testing/fake-agent-runtime.js';
import { TestWorkspace } from '../system/testing/test-workspace.js';
import { BrokenNoteReports } from './broken-note-reports.js';
import { NotificationsModule } from './notifications.module.js';

const OWNER = privateChat('1234');
const FORUM = groupChat('-1001', 'Household');


/** The `channel-id` of the forum's Health topic. */
const HEALTH = 'telegram:-1001:7';

describe('BrokenNoteReports', () => {
  let ws: TestWorkspace;
  let moduleRef: TestingModule | undefined;
  let ds: DataSource;
  let adapter: FakeChannelAdapter;

  beforeEach(() => {
    ws = TestWorkspace.create('pero-broken-');
  });

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
    ws.delete();
  });

  /**
   * Starts the module, then allows the owner's direct chat and the
   * Household forum, and has Pero see their Channels: the direct chat, and
   * the forum's Health and Home topics.
   */
  async function start() {
    moduleRef = await Test.createTestingModule({
      imports: [
        PersistenceModule.forRoot({ database: ws.database }),
        ws.hostConfig(),
        ChannelsModule,
        NotificationsModule,
      ],
    })
      .overrideProvider(AGENT_RUNTIMES)
      .useValue([new FakeAgentRuntime('claude'), new FakeAgentRuntime('codex')])
      .compile();
    await moduleRef.init();
    ds = moduleRef.get<DataSource>(getDataSourceToken());
    const allowed = moduleRef.get(AllowedChatsService);
    for (const chat of [OWNER, FORUM]) {
      await allowed.allow({
        integrationKind: 'telegram',
        chatKey: chat.key,
        kind: chat.kind,
        title: chat.title,
      });
    }
    const save = async (channel: InboundChannel): Promise<void> => {
      await ds.getRepository(Channel).save({
        integrationKind: 'telegram' as const,
        externalKey: channel.key,
        address: channel.address,
        title: channel.title,
      });
    };
    await save(inboundChannel(OWNER));
    await save(inboundChannel(FORUM, '7', 'Health'));
    await save(inboundChannel(FORUM, '8', 'Home'));
    ws.use(moduleRef);
    // Workflow notes resolve against these from the next scan.
    await ws.rescan();
    adapter = new FakeChannelAdapter();
    await moduleRef.get(ChannelRouter).connect(adapter);
  }

  /** What was posted since the last look, as [Channel address, text]. */
  async function posted(): Promise<[string, string][]> {
    await moduleRef!.get(BrokenNoteReports).idle();
    const sent = adapter.sent.splice(0);
    return sent.map(({ address, message }) => [
      [address.chatId, address.messageThreadId].filter(Boolean).join(':'),
      message.text ?? '',
    ]);
  }

  it('posts once per broken version of a Workflow note, to its Channel, and nothing once it is fixed', async () => {
    await ws.pero();
    await ws.channel('Health', { 'channel-id': HEALTH });
    await start();

    await ws.workflow('Report', { channel: ['Health', 'Helth'] }, 'Report.');
    expect(await posted()).toEqual([
      [
        '-1001:7',
        [
          'Errors in data/System/Workflows/Report.md:',
          'channel: no Channel note named "Helth"; Channel notes: Health',
          "It's left out until it's fixed.",
        ].join('\n'),
      ],
    ]);
    // Seen again, as the next scan would: not posted again.
    await ws.rescan();
    await ws.pero({ timezone: 'UTC' });
    expect(await posted()).toEqual([]);

    // Still broken, another way: one more message.
    await ws.workflow('Report', { channel: ['Health', 'Hleth'] }, 'Report.');
    expect(await posted()).toMatchObject([['-1001:7', expect.any(String)]]);

    await ws.workflow('Report', { channel: 'Health' }, 'Report.');
    expect(await posted()).toEqual([]);
    // Broken again as before: posted again.
    await ws.workflow('Report', { channel: ['Health', 'Hleth'] }, 'Report.');
    expect(await posted()).toHaveLength(1);

    // None of it is recorded in Channel history.
    expect(await ds.getRepository(Message).count()).toBe(0);
  });

  it('posts to a primary Channel when no Channel the note names is known', async () => {
    await start();

    await ws.workflow('Report', { channel: 'Helth' }, 'Report.');
    expect(await posted()).toEqual([
      [
        '1234',
        expect.stringContaining('channel: no Channel note named "Helth"'),
      ],
    ]);
    await ws.write('Pero.md', '---\ntimezone: Mars/Base\n---\n');
    await ws.rescan();
    expect(await posted()).toEqual([
      [
        '1234',
        [
          'Errors in data/System/Pero.md:',
          'timezone: must be an IANA time zone such as Europe/Berlin',
          "Pero's own defaults are used until it's fixed.",
        ].join('\n'),
      ],
    ]);
  });

  it('posts to the Channel of a Channel note while its last good version stays in use', async () => {
    await ws.channel('Coach', { 'channel-id': HEALTH }, 'You coach.');
    await start();

    await ws.editChannel('Coach', { effort: 'huge' });
    // A version with errors is used, and reported, once a second scan finds it.
    expect(await posted()).toEqual([]);
    await ws.rescan();
    expect(await posted()).toEqual([
      [
        '-1001:7',
        [
          'Errors in data/System/Channels/Coach.md:',
          'effort: must be low, medium, high, xhigh, max, minimal, ultra, or persistent',
          'Its last good version stays in use.',
        ].join('\n'),
      ],
    ]);
  });

  it('posts one message per Channel for notes broken together', async () => {
    await ws.channel('Coach', { 'channel-id': HEALTH }, 'You coach.');
    await start();

    await ws.channel('Doctor', { 'channel-id': HEALTH }, 'You heal.');
    const sent = await posted();
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe('-1001:7');
    expect(sent[0]![1].split('\n\n')).toEqual([
      [
        'Errors in data/System/Channels/Coach.md:',
        `channel-id: ${HEALTH} is also the channel-id of Channels/Doctor.md; keep it in only one of them`,
        "It's left out until it's fixed.",
      ].join('\n'),
      [
        'Errors in data/System/Channels/Doctor.md:',
        `channel-id: ${HEALTH} is also the channel-id of Channels/Coach.md; keep it in only one of them`,
        "It's left out until it's fixed.",
      ].join('\n'),
    ]);
  });

  it('only logs notes broken at startup', async () => {
    await ws.workflow('Report', { channel: 'Helth' }, 'Report.');
    await start();
    await ws.rescan();
    await ws.pero({ timezone: 'UTC' });
    expect(await posted()).toEqual([]);
  });

  it('only logs a broken note when Pero has seen no Channel to post it in', async () => {
    await start();
    await ds.getRepository(Channel).clear();

    await ws.workflow('Report', { channel: 'Helth' }, 'Report.');
    expect(await posted()).toEqual([]);
  });
});
