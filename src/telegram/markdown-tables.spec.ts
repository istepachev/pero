import { describe, expect, it } from 'vitest';
import { displayWidth, renderTable, renderTables } from './markdown-tables.js';

describe('displayWidth', () => {
  it('counts emoji and East Asian wide characters as two cells', () => {
    expect(displayWidth('Today')).toBe(5);
    expect(displayWidth('Сегодня')).toBe(7);
    expect(displayWidth('✅')).toBe(2);
    expect(displayWidth('⚠️')).toBe(2);
    expect(displayWidth('👍🏽')).toBe(2);
    expect(displayWidth('👨‍👩‍👧')).toBe(2);
    expect(displayWidth('🇩🇪')).toBe(2);
    expect(displayWidth('日本')).toBe(4);
    expect(displayWidth('é')).toBe(1);
  });
});

describe('renderTable', () => {
  it('pads the columns to the same display width', () => {
    expect(
      renderTable(
        ['Метрика', 'Статус'],
        ['left', 'left'],
        [
          ['Сон', '✅ ok'],
          ['Шаги', 'мало'],
        ],
      ),
    ).toBe(
      '```\n' +
        'Метрика │ Статус\n' +
        '────────┼───────\n' +
        'Сон     │ ✅ ok\n' +
        'Шаги    │ мало\n' +
        '```',
    );
  });

  it('aligns columns as the delimiter row says', () => {
    expect(
      renderTable(
        ['Item', 'Qty', 'Note'],
        ['left', 'right', 'center'],
        [['tea', '2', 'hot']],
      ),
    ).toBe('```\nItem │ Qty │ Note\n─────┼─────┼─────\ntea  │   2 │ hot\n```');
  });

  it('drops the Markdown in cells', () => {
    expect(
      renderTable(
        ['**Name**', 'Link'],
        ['left', 'left'],
        [['`npm i` and _it_', '[docs](https://example.com)<br>~~old~~']],
      ),
    ).toBe(
      '```\nName         │ Link\n─────────────┼─────────\nnpm i and it │ docs old\n```',
    );
  });

  it('fences a table with backticks in it with a longer fence', () => {
    expect(
      renderTable(['a'], ['left'], [['x \\`\\`\\` y']]).split('\n')[0],
    ).toBe('````');
  });

  it('falls back to rows of "Header: value" lines past the width', () => {
    expect(
      renderTable(
        ['Day', 'Note'],
        ['left', 'left'],
        [
          ['Mon', 'a long note: 2 \\* 3 = *six*'],
          ['Tue', ''],
        ],
        20,
      ),
    ).toBe(
      '**Day:** Mon\n**Note:** a long note: 2 \\* 3 = six\n\n**Day:** Tue',
    );
  });
});

describe('renderTables', () => {
  it('finds tables with and without outer pipes, and their extent', () => {
    const markdown = 'Intro\na | b\n--|--\n1 | 2\n3\n\nafter | not a table';
    const { markdown: rendered, blocks } = renderTables(markdown);
    expect(rendered).toBe(
      'Intro\n```\na │ b\n──┼──\n1 │ 2\n```\n3\n\nafter | not a table',
    );
    expect(blocks).toHaveLength(1);
    const [{ start, end }] = blocks as [{ start: number; end: number }];
    expect(rendered.slice(start, end)).toBe('```\na │ b\n──┼──\n1 │ 2\n```');
  });

  it('keeps escaped pipes and pipes in code inside their cell', () => {
    expect(
      renderTables('| a | b |\n|---|---|\n| x \\| y | `p|q` |').markdown,
    ).toBe('```\na     │ b\n──────┼────\nx | y │ p|q\n```');
  });

  it('pads short rows and drops cells past the header', () => {
    expect(
      renderTables('| a | b |\n|---|---|\n| 1 |\n| 2 | 3 | 4 |').markdown,
    ).toBe('```\na │ b\n──┼──\n1 │\n2 │ 3\n```');
  });

  it('leaves alone what is not a table', () => {
    for (const text of [
      'a | b\nno delimiter',
      '| a | b |\n|---|',
      '---\n| a |',
      '```\n| a | b |\n|---|---|\n```',
      'plain text',
    ]) {
      expect(renderTables(text)).toEqual({ markdown: text, blocks: [] });
    }
  });
});
