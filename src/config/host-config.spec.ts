import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from './bootstrap-config.js';
import {
  allowChat,
  chatKindOf,
  dataFolderValue,
  defaultHostConfig,
  denyChat,
  editHostConfig,
  moveChatId,
  parseHostConfig,
  readHostConfig,
  resolveDataFolder,
  setDataFolder,
} from './host-config.js';

/** Beyond 2^53, where a JavaScript number would lose the last digits. */
const BIG = '-1009007199254740993';

describe('parseHostConfig', () => {
  it('reads the data folder, settings folder, and allowed chats', () => {
    const config = parseHostConfig(
      'config.yaml',
      [
        'data: ~/notes',
        'settings: notes/Settings',
        'telegram:',
        '  allowed-chats:',
        `    - id: ${BIG}`,
        '      title: Home',
        '    - id: "123456789"',
      ].join('\n'),
    );

    expect(config).toEqual({
      data: '~/notes',
      settings: 'notes/Settings',
      allowedChats: [
        { chatKey: BIG, title: 'Home' },
        { chatKey: '123456789', title: null },
      ],
    });
  });

  it('takes an empty file, and the template, as nothing set', () => {
    expect(parseHostConfig('config.yaml', '')).toEqual({
      data: null,
      settings: null,
      allowedChats: [],
    });
    expect(parseHostConfig('config.yaml', defaultHostConfig())).toEqual({
      data: 'data',
      settings: null,
      allowedChats: [],
    });
    expect(
      parseHostConfig('config.yaml', defaultHostConfig({ data: null })).data,
    ).toBeNull();
  });

  it('names the file, line, and key of each problem', () => {
    const parse = () =>
      parseHostConfig(
        '/ws/.pero/config.yaml',
        [
          'data: 5',
          'modle: x',
          'telegram:',
          '  allowed-chats:',
          '    - id: abc',
          '    - id: 1',
          '    - id: 1',
          '      name: Home',
        ].join('\n'),
      );

    expect(parse).toThrow(ConfigError);
    expect(parse).toThrow(
      [
        'Invalid /ws/.pero/config.yaml:',
        '  line 1: data: must be a folder path',
        '  line 5: telegram.allowed-chats (item 1).id: must be a Telegram chat ID, such as -1001234567890 or 123456789',
        '  line 8: telegram.allowed-chats (item 3).name: unknown key',
        '  line 7: telegram.allowed-chats (item 3).id: 1 is listed twice',
        '  line 2: modle: unknown key',
      ].join('\n'),
    );
  });

  it('reports YAML that does not parse', () => {
    expect(() => parseHostConfig('config.yaml', 'data: [')).toThrow(
      /^Invalid config\.yaml:\n {2}line 1: /,
    );
    expect(() => parseHostConfig('config.yaml', '- data')).toThrow(
      'must be "key: value" lines',
    );
  });
});

describe('config.yaml on disk', () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-host-config-'));
    file = join(tmp, 'config.yaml');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reads nothing when there is no file', () => {
    expect(readHostConfig(file)).toBeNull();
  });

  it('starts a missing file from the template', () => {
    const config = editHostConfig(file, (document) => {
      allowChat(document, '123456789', null);
    });

    expect(config.allowedChats).toEqual([
      { chatKey: '123456789', title: null },
    ]);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain("# Pero's host settings");
    expect(text).toContain('  allowed-chats:\n    - id: 123456789\n');
  });

  it('keeps comments, order, and hand edits through its own changes', () => {
    writeFileSync(
      file,
      [
        '# My Pero',
        'telegram:',
        '  allowed-chats:',
        '    - id: -100111   # the family group',
        '      title: Family',
        '',
        'data: vault # synced',
        '',
      ].join('\n'),
      { mode: 0o640 },
    );

    editHostConfig(file, (document) => allowChat(document, BIG, 'Home'));
    // Someone edits by hand between two of Pero's changes.
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('Family', 'Family chat'),
    );
    editHostConfig(file, (document) => denyChat(document, BIG));
    editHostConfig(file, (document) => setDataFolder(document, 'notes'));

    expect(readFileSync(file, 'utf8')).toBe(
      [
        '# My Pero',
        'telegram:',
        '  allowed-chats:',
        '    - id: -100111 # the family group',
        '      title: Family chat',
        '',
        'data: notes # synced',
        '',
      ].join('\n'),
    );
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  it('allows a chat once, adding a missing title', () => {
    writeFileSync(file, 'telegram:\n  allowed-chats:\n    - id: 5\n');
    let changes: boolean[] = [];

    editHostConfig(file, (document) => {
      changes = [
        allowChat(document, '5', null),
        allowChat(document, '5', 'Me'),
        allowChat(document, '5', 'Other'),
      ];
    });

    expect(changes).toEqual([false, true, false]);
    expect(readHostConfig(file)?.allowedChats).toEqual([
      { chatKey: '5', title: 'Me' },
    ]);
  });

  it('writes a list left empty as []', () => {
    writeFileSync(file, 'telegram:\n  allowed-chats:\n    - id: 5\n');

    editHostConfig(file, (document) => denyChat(document, '5'));

    expect(readFileSync(file, 'utf8')).toBe('telegram:\n  allowed-chats: []\n');
  });

  it('keeps every digit of a large ID it writes', () => {
    editHostConfig(file, (document) => allowChat(document, BIG, null));

    expect(readFileSync(file, 'utf8')).toContain(`- id: ${BIG}\n`);
    expect(readHostConfig(file)?.allowedChats[0]?.chatKey).toBe(BIG);
  });

  it('follows a chat to its new ID, or drops it when that is allowed too', () => {
    writeFileSync(
      file,
      'telegram:\n  allowed-chats:\n    - id: -1\n      title: Old\n    - id: -2\n',
    );

    let moved: boolean[] = [];
    editHostConfig(file, (document) => {
      moved = [
        moveChatId(document, '-1', '-1001'),
        moveChatId(document, '-2', '-1001'),
        moveChatId(document, '-3', '-1003'),
      ];
    });

    expect(moved).toEqual([true, true, false]);
    expect(readHostConfig(file)?.allowedChats).toEqual([
      { chatKey: '-1001', title: 'Old' },
    ]);
  });

  it('refuses to change a file that is not valid, leaving it as it is', () => {
    writeFileSync(file, 'dta: data\n');

    expect(() =>
      editHostConfig(file, (document) => allowChat(document, '5', null)),
    ).toThrow('line 1: dta: unknown key');
    expect(readFileSync(file, 'utf8')).toBe('dta: data\n');
  });
});

describe('data folder', () => {
  it('resolves relative to the workspace, with data/ by default', () => {
    expect(resolveDataFolder({ data: null }, '/ws', true)).toBe('/ws/data');
    expect(resolveDataFolder({ data: 'vault' }, '/ws', true)).toBe('/ws/vault');
    expect(resolveDataFolder({ data: '~/notes' }, '/ws', true, '/home/o')).toBe(
      '/home/o/notes',
    );
    expect(resolveDataFolder({ data: null }, '/home/o/.pero', false)).toBe(
      null,
    );
  });

  it('is written relative to the workspace when inside it', () => {
    expect(dataFolderValue('/ws/data', '/ws')).toBe('data');
    expect(dataFolderValue('/ws', '/ws')).toBe('.');
    expect(dataFolderValue('/srv/notes', '/ws')).toBe('/srv/notes');
    expect(dataFolderValue('/ws/data', null)).toBe('/ws/data');
  });
});

describe('chatKindOf', () => {
  it('takes negative IDs for groups and positive ones for people', () => {
    expect(chatKindOf('-1001234567890')).toBe('group');
    expect(chatKindOf('123456789')).toBe('private');
  });
});
