// Unit tests for "record, then replay" (deferred-html.ts): parsing with the
// HTML converted elsewhere must give EXACTLY the result of parsing with the
// converter called directly, for every kind of converter behaviour.
//
// The converters here are stubs, NOT converters: Node has no DOMParser. The
// real converter on this path is checked in Chromium by
// e2e/parse-files.spec.ts.

import { describe, expect, it, vi } from 'vitest';
import { buildMsg, type MsgSpec } from '../../tests/fixtures/msg/builder';
import { MSG_SPECS } from '../../tests/fixtures/msg/specs';
import { convertHtmlList, parseWithDeferredHtml, type ConversionOutcome } from './deferred-html';
import { createEmlParser } from './eml';
import type { FileKind } from './file-type';
import type { HtmlToTextResult } from './html-to-text';
import { createMsgParser } from './msg';
import type { InputFile, ParseResult } from './types';

const fixtureFiles = import.meta.glob<string>('../../tests/fixtures/eml/*.eml', { query: '?raw', import: 'default', eager: true });

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A synthetic .eml: headers, then `body` (a MIME body with its own Content-Type header lines). */
function eml(contentType: string, body: string): string {
  return [
    'X-Synthetic-Fixture: true',
    'From: Alice Example <alice@example.test>',
    'To: Bob Sample <bob@example.test>',
    'Subject: Deferred HTML test',
    'Date: Tue, 03 Jun 2025 12:05:09 +0200',
    'Message-ID: <deferred@example.test>',
    'MIME-Version: 1.0',
    `Content-Type: ${contentType}`,
    '',
    body,
  ].join('\r\n');
}

/** A multipart body from parts written as "Content-Type line(s)\r\n\r\ncontent". */
function multipart(boundary: string, parts: readonly string[]): string {
  return `${parts.map((p) => `--${boundary}\r\n${p}\r\n`).join('')}--${boundary}--\r\n`;
}

const HTML_PART = (html: string): string => `Content-Type: text/html; charset=utf-8\r\n\r\n${html}`;
const PLAIN_PART = (text: string): string => `Content-Type: text/plain; charset=utf-8\r\n\r\n${text}`;

/** Synthetic .eml files that exercise how converted texts are joined. */
const EDGE_EMLS: Record<string, string> = {
  'html-only': eml('text/html; charset=utf-8', '<p>Only HTML</p>'),
  'plain, html, plain': eml(
    'multipart/mixed; boundary="b1"',
    multipart('b1', [PLAIN_PART('Intro'), HTML_PART('<p>Middle</p>'), PLAIN_PART('Outro')]),
  ),
  'html first, then plain': eml('multipart/mixed; boundary="b2"', multipart('b2', [HTML_PART('<b>First</b>'), PLAIN_PART('Then')])),
  'two html versions in alternative': eml(
    'multipart/alternative; boundary="b3"',
    multipart('b3', [HTML_PART('<p>Version A</p>'), HTML_PART('<p>Version B</p>')]),
  ),
  'html, forwarded message with html, html': eml(
    'multipart/mixed; boundary="b4"',
    multipart('b4', [
      HTML_PART('<p>Before</p>'),
      `Content-Type: message/rfc822\r\n\r\n${eml('text/html; charset=utf-8', '<p>Forwarded HTML</p>')}`,
      HTML_PART('<p>After</p>'),
    ]),
  ),
  'plain and html alternative (no conversion)': eml(
    'multipart/alternative; boundary="b5"',
    multipart('b5', [PLAIN_PART('Plain version'), HTML_PART('<p>HTML version</p>')]),
  ),
};

const HTML_ONLY_MSG: MsgSpec = {
  id: 'deferred-html-only',
  description: 'HTML-only .msg for the deferred path',
  strings: 'unicode',
  subject: 'HTML only',
  sender: { name: 'Alice Example', smtp: 'alice@example.test' },
  recipients: [{ name: 'Bob Sample', smtp: 'bob@example.test', type: 'to' }],
  bodyHtml: '<p>Hello from HTML</p>',
  submitTime: '2025-06-03T12:05:09Z',
  messageId: '<deferred-msg@example.test>',
};

interface Case {
  readonly label: string;
  readonly kind: FileKind;
  readonly file: InputFile;
}

const CASES: Case[] = [
  ...Object.entries(fixtureFiles).map(([path, text]) => ({ label: path.slice(path.lastIndexOf('/') + 1), kind: 'eml' as const, file: { name: path, bytes: encode(text) } })),
  ...Object.entries(EDGE_EMLS).map(([label, text]) => ({ label, kind: 'eml' as const, file: { name: `${label}.eml`, bytes: encode(text) } })),
  ...[...MSG_SPECS, HTML_ONLY_MSG].map((spec) => ({ label: spec.id, kind: 'msg' as const, file: { name: `${spec.id}.msg`, bytes: buildMsg(spec) } })),
];

/** Converter behaviours. Each call of a factory gives a fresh converter (some count their calls). */
const CONVERTERS: Record<string, () => (html: string) => HtmlToTextResult> = {
  'returns a text': () => (html) => ({ text: `[stub ${String(html.length)}]`, truncated: false }),
  'returns an empty text': () => () => ({ text: '', truncated: false }),
  'returns a text ending in a line break': () => (html) => ({ text: `line ${String(html.length)}\n`, truncated: false }),
  'returns a cut text': () => (html) => ({ text: `cut ${String(html.length)}`, truncated: true }),
  'cuts only the second call': () => {
    let calls = 0;
    return () => ({ text: `call ${String(++calls)}`, truncated: calls === 2 });
  },
  'throws an Error': () => () => {
    throw new RangeError('Maximum call stack size exceeded');
  },
  'throws a string': () => () => {
    // Deliberately not an Error: a converter may throw anything.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw 'plain string';
  },
  'throws an empty message': () => () => {
    throw new Error('   ');
  },
  'throws on the second call': () => {
    let calls = 0;
    return () => {
      if (++calls === 2) throw new Error('second call failed');
      return { text: 'first', truncated: false };
    };
  },
  'returns no result': () => () => null as unknown as HtmlToTextResult,
};

function directParse(c: Case, htmlToText: (html: string) => HtmlToTextResult): Promise<ParseResult> {
  const parser = c.kind === 'eml' ? createEmlParser({ htmlToText }) : createMsgParser({ htmlToText });
  return parser.parse(c.file);
}

describe('parseWithDeferredHtml gives exactly the direct result', () => {
  for (const [converterLabel, makeConverter] of Object.entries(CONVERTERS)) {
    describe(converterLabel, () => {
      it.each(CASES.map((c) => [c.label, c] as const))('%s', async (_label, c) => {
        const direct = await directParse(c, makeConverter());
        const pageConverter = makeConverter();
        const deferred = await parseWithDeferredHtml(c.file, c.kind, (htmls) => Promise.resolve(convertHtmlList(htmls, pageConverter)));
        expect(deferred).toEqual(direct);
      });
    });
  }

  it('the edge cases really do convert HTML, and some are joined differently for an empty text', async () => {
    const edge = CASES.find((c) => c.label === 'plain, html, plain');
    if (edge === undefined) throw new Error('missing case');
    const withText = await directParse(edge, () => ({ text: 'M', truncated: false }));
    const withEmpty = await directParse(edge, () => ({ text: '', truncated: false }));
    expect(withText.ok && withText.message.bodyText).toBe('Intro\nM\nOutro');
    // A placeholder in place of '' would have given 'Intro\n\nOutro'.
    expect(withEmpty.ok && withEmpty.message.bodyText).toBe('Intro\nOutro');
  });
});

describe('parseWithDeferredHtml: the page round trip', () => {
  it('a message without HTML to convert never asks the page', async () => {
    const convertOnPage = vi.fn();
    const c = CASES.find((x) => x.label === 'plain and html alternative (no conversion)');
    if (c === undefined) throw new Error('missing case');
    const result = await parseWithDeferredHtml(c.file, 'eml', convertOnPage);
    expect(result.ok).toBe(true);
    expect(convertOnPage).not.toHaveBeenCalled();
  });

  it('asks the page once, with every HTML string in file order', async () => {
    const c = CASES.find((x) => x.label === 'html, forwarded message with html, html');
    if (c === undefined) throw new Error('missing case');
    const asked: (readonly string[])[] = [];
    const result = await parseWithDeferredHtml(c.file, 'eml', (htmls) => {
      asked.push(htmls);
      return Promise.resolve(htmls.map((h): ConversionOutcome => ({ ok: true, text: h.replace(/<[^>]*>/g, ''), truncated: false })));
    });
    // postal-mime keeps the line break that ends the inner message's body.
    expect(asked.map((list) => list.map((h) => h.trimEnd()))).toEqual([['<p>Before</p>', '<p>Forwarded HTML</p>', '<p>After</p>']]);
    expect(asked[0]?.length).toBe(3);
    expect(result.ok && result.message.bodyText).toContain('Before');
    expect(result.ok && result.message.bodyText).toContain('Forwarded HTML');
    expect(result.ok && result.message.warnings).toContain('html-converted-body');
  });

  it("propagates the page's cut flag as 'html-body-truncated' (.eml and .msg)", async () => {
    for (const c of CASES.filter((x) => x.label === 'html-only' || x.label === HTML_ONLY_MSG.id)) {
      const result = await parseWithDeferredHtml(c.file, c.kind, (htmls) =>
        Promise.resolve(htmls.map((): ConversionOutcome => ({ ok: true, text: 'Cut text\n\n[Text cut here]', truncated: true }))),
      );
      expect(result.ok && result.message.bodyText).toBe('Cut text\n\n[Text cut here]');
      expect(result.ok && [...result.message.warnings]).toEqual(expect.arrayContaining(['html-converted-body', 'html-body-truncated']));
    }
  });

  it("reports a page failure as 'HTML body could not be converted: ...', never as a damaged file", async () => {
    for (const c of CASES.filter((x) => x.label === 'html-only' || x.label === HTML_ONLY_MSG.id)) {
      const result = await parseWithDeferredHtml(c.file, c.kind, () => Promise.resolve([{ ok: false, reason: 'too deep' }]));
      expect(result).toMatchObject({ ok: false, error: 'corrupt', detail: 'HTML body could not be converted: too deep' });
    }
  });

  it('a page answer with missing conversions fails the file with a plain detail', async () => {
    const c = CASES.find((x) => x.label === 'plain, html, plain');
    if (c === undefined) throw new Error('missing case');
    const result = await parseWithDeferredHtml(c.file, 'eml', () => Promise.resolve([]));
    expect(result).toMatchObject({
      ok: false,
      error: 'corrupt',
      detail: 'HTML body could not be converted: the converted text did not come back from the page',
    });
  });

  it('email text that looks like a marker or a converted text is never touched', async () => {
    // There are no markers: the replayed conversion is handed to the adapter
    // as the converter's own return value, so text in the email that
    // resembles anything is kept as it is.
    const tricky = '[stub 13] \u0000PLACEHOLDER-0\u0000 {{html:0}}';
    const file = { name: 'tricky.eml', bytes: encode(eml('multipart/mixed; boundary="t"', multipart('t', [PLAIN_PART(tricky), HTML_PART('<p>Real</p>')]))) };
    const result = await parseWithDeferredHtml(file, 'eml', (htmls) =>
      Promise.resolve(htmls.map((): ConversionOutcome => ({ ok: true, text: 'Real', truncated: false }))),
    );
    expect(result.ok && result.message.bodyText).toBe(`${tricky}\nReal`);
  });
});

describe('convertHtmlList (on the page)', () => {
  it('converts in order and keeps the cut flag', () => {
    expect(convertHtmlList(['<a>', '<bb>'], (h) => ({ text: String(h.length), truncated: h.length > 3 }))).toEqual([
      { ok: true, text: '3', truncated: false },
      { ok: true, text: '4', truncated: true },
    ]);
  });

  it('stops at the first failure, with the bare reason', () => {
    const converter = vi.fn((h: string): HtmlToTextResult => {
      if (h === 'bad') throw new TypeError('broken');
      return { text: h, truncated: false };
    });
    expect(convertHtmlList(['ok', 'bad', 'never'], converter)).toEqual([
      { ok: true, text: 'ok', truncated: false },
      { ok: false, reason: 'broken' },
    ]);
    expect(converter).toHaveBeenCalledTimes(2);
  });

  it('a result that is not { text, truncated } is a failure with the same reason as a direct call', () => {
    expect(convertHtmlList(['x'], () => ({ text: 1 }) as unknown as HtmlToTextResult)).toEqual([
      { ok: false, reason: 'the converter returned no text' },
    ]);
  });

  it('keeps only text and truncated from the converter result', () => {
    const extra = { text: 't', truncated: false, html: '<script>' } as HtmlToTextResult;
    expect(convertHtmlList(['x'], () => extra)).toEqual([{ ok: true, text: 't', truncated: false }]);
  });
});
