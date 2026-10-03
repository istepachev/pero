import { describe, expect, it } from 'vitest';
import { markdownToTelegramHtml, splitMarkdown } from './telegram-markdown.js';

const html = markdownToTelegramHtml;

describe('markdownToTelegramHtml', () => {
  it('leaves plain text as it is, its markup characters escaped', () => {
    expect(html('Done. See Health/Log.md.')).toBe('Done. See Health/Log.md.');
    expect(html('a < b && c > "d"')).toBe(
      'a &lt; b &amp;&amp; c &gt; &quot;d&quot;',
    );
    expect(html('<b>not a tag</b>')).toBe('&lt;b&gt;not a tag&lt;/b&gt;');
  });

  it('shows emphasis, strikethrough, and spoilers', () => {
    expect(html('**bold** and __bold__')).toBe('<b>bold</b> and <b>bold</b>');
    expect(html('*italic* and _italic_')).toBe(
      '<i>italic</i> and <i>italic</i>',
    );
    expect(html('~~gone~~ and ||hidden||')).toBe(
      '<s>gone</s> and <tg-spoiler>hidden</tg-spoiler>',
    );
  });

  it('nests emphasis', () => {
    expect(html('**bold *and italic***')).toBe('<b>bold <i>and italic</i></b>');
    expect(html('*italic **and bold** too*')).toBe(
      '<i>italic <b>and bold</b> too</i>',
    );
    expect(html('[**Pero** docs](https://example.com)')).toBe(
      '<a href="https://example.com"><b>Pero</b> docs</a>',
    );
  });

  it('leaves markers that open or close nothing as they are', () => {
    expect(html('2 * 3 * 4')).toBe('2 * 3 * 4');
    expect(html('**not closed')).toBe('**not closed');
    expect(html('** spaced **')).toBe('** spaced **');
    expect(html('a **b\nc** d')).toBe('a **b\nc** d');
  });

  it('keeps underscores inside words, as in names and paths', () => {
    expect(html('my_var_name and /data/my_notes/to_do.md')).toBe(
      'my_var_name and /data/my_notes/to_do.md',
    );
    expect(html('snake_case_ word')).toBe('snake_case_ word');
  });

  it('honours backslash escapes', () => {
    expect(html('\\*not italic\\*')).toBe('*not italic*');
    expect(html('C:\\Users')).toBe('C:\\Users');
  });

  it('shows inline code as it is written', () => {
    expect(html('Run `npm i **x** <y>`.')).toBe(
      'Run <code>npm i **x** &lt;y&gt;</code>.',
    );
    expect(html('``a ` b``')).toBe('<code>a ` b</code>');
    expect(html('**see `a*b`**')).toBe('<b>see <code>a*b</code></b>');
    expect(html('a ` b')).toBe('a ` b');
  });

  it('shows fenced code blocks, with their language', () => {
    expect(html('Try:\n```ts\nconst a = 1 < 2;\n**x**\n```\nDone.')).toBe(
      'Try:\n<pre><code class="language-ts">const a = 1 &lt; 2;\n**x**</code></pre>\nDone.',
    );
    expect(html('~~~\nplain\n~~~')).toBe('<pre>plain</pre>');
    expect(html('```\nnot closed')).toBe('<pre>not closed</pre>');
    expect(html('```a"b\nx\n```')).toBe('<pre>x</pre>');
  });

  it('links only to web, Telegram, and mail addresses', () => {
    expect(html('[site](https://example.com/a?b=1&c=2)')).toBe(
      '<a href="https://example.com/a?b=1&amp;c=2">site</a>',
    );
    expect(html('[me](tg://user?id=1) [mail](mailto:a@b.c)')).toBe(
      '<a href="tg://user?id=1">me</a> <a href="mailto:a@b.c">mail</a>',
    );
    expect(html('[note](Health/Log.md)')).toBe('[note](Health/Log.md)');
    expect(html('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))');
  });

  it('shows quotes, headings, list items, and rules', () => {
    expect(html('> one **b**\n>\n> two\nafter')).toBe(
      '<blockquote>one <b>b</b>\n\ntwo</blockquote>\nafter',
    );
    expect(html('# Title\n### More *here* ###')).toBe(
      '<b>Title</b>\n<b>More <i>here</i></b>',
    );
    expect(html('- one\n* two\n  + nested\n1. first')).toBe(
      '• one\n• two\n  • nested\n1. first',
    );
    expect(html('above\n---\nbelow')).toBe('above\n———\nbelow');
    expect(html('#hashtag')).toBe('#hashtag');
  });

  it('leaves a table as it is written', () => {
    expect(html('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(
      '| a | b |\n|---|---|\n| 1 | 2 |',
    );
  });
});

describe('splitMarkdown', () => {
  it('splits as plain text does outside code', () => {
    expect(splitMarkdown('aaaa bbbb', 5)).toEqual(['aaaa ', 'bbbb']);
    expect(splitMarkdown('short')).toEqual(['short']);
  });

  it('closes a code block cut in two and opens it again', () => {
    const parts = splitMarkdown('```ts\nline1\nline2\nline3\n```\nafter', 14);
    expect(parts).toEqual([
      '```ts\nline1\n```',
      '```ts\nline2\nline3\n```',
      'after',
    ]);
    expect(parts.slice(0, 2).map(html)).toEqual([
      '<pre><code class="language-ts">line1</code></pre>',
      '<pre><code class="language-ts">line2\nline3</code></pre>',
    ]);
  });

  it('drops a closing fence the part before already closed', () => {
    expect(splitMarkdown('```ts\nline1\nline2\n```\nafter', 18)).toEqual([
      '```ts\nline1\nline2\n```',
      'after',
    ]);
    expect(splitMarkdown('```\nline1\nline2\n```', 18)).toEqual([
      '```\nline1\nline2\n```',
    ]);
  });

  it('opens nothing again once the block closes in its part', () => {
    expect(splitMarkdown('```\nx\n```\nsome more words', 12)).toEqual([
      '```\nx\n```\n',
      'some more ',
      'words',
    ]);
  });
});
