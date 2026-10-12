// Unit tests for the .eml adapter. Every message is built in memory from
// synthetic text and bytes (README.md, rule R7); nothing is read from disk.

import { decodeWords } from 'postal-mime';
import { describe, expect, it, vi } from 'vitest';
import { createEmlParser } from './eml';
import { sha256Hex } from './hash';
import type { NormalizedMessage, ParseResult } from './types';

// decodeWords is wrapped in a spy that calls the real function, so that one
// test can simulate a library that leaves a line break in a decoded header.
vi.mock('postal-mime', async (importOriginal) => {
  const original = await importOriginal<typeof import('postal-mime')>();
  return { ...original, decodeWords: vi.fn(original.decodeWords) };
});

/** Joins text (encoded as UTF-8) and raw byte arrays into one file. */
function bytes(...parts: (string | readonly number[])[]): Uint8Array {
  const chunks = parts.map((p) => (typeof p === 'string' ? new TextEncoder().encode(p) : Uint8Array.from(p)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Lines joined with CRLF, as in a real .eml file. */
const crlf = (...lines: string[]): string => lines.join('\r\n');

const HEADERS = crlf(
  'From: Alice Example <alice@example.test>',
  'To: Bob Sample <bob@example.test>',
  'Subject: Test message',
  'Date: Tue, 3 Jun 2025 14:05:09 +0200',
  'Message-ID: <m1@example.test>',
  'MIME-Version: 1.0',
);

/** A stub, NOT a converter: it only shows that the HTML path was taken. */
const stubHtmlToText = (html: string): string => `[stub] ${html.length}`;
const parser = createEmlParser({ htmlToText: stubHtmlToText });

async function parse(data: Uint8Array, name = 'test.eml'): Promise<ParseResult> {
  return parser.parse({ name, bytes: data });
}

async function parseOk(data: Uint8Array): Promise<NormalizedMessage> {
  const result = await parse(data);
  if (!result.ok) throw new Error(`expected ok, got ${result.error}: ${result.detail}`);
  return result.message;
}

describe('createEmlParser: basic fields', () => {
  it('fills source with the file name, the SHA-256 of the bytes and kind "eml"', async () => {
    const data = bytes(HEADERS, '\r\n\r\nHello.\r\n');
    const message = await parseOk(data);
    expect(message.source).toEqual({ fileName: 'test.eml', sha256: await sha256Hex(data), kind: 'eml' });
    expect(message.bodyText).toBe('Hello.\n');
    expect(message.warnings).toEqual([]);
  });

  it('normalizes ids: no < >, trimmed, References in order across folded lines', async () => {
    const data = bytes(
      crlf(
        'From: alice@example.test',
        'Date: Tue, 3 Jun 2025 14:05:09 +0200',
        'Message-ID:   <  m3@example.test >  ',
        'In-Reply-To: <m2@example.test> (message from Bob)',
        'References: <m1@example.test>',
        '\t<m2@example.test>',
      ),
      '\r\n\r\nBody\r\n',
    );
    const message = await parseOk(data);
    expect(message.messageId).toBe('m3@example.test');
    expect(message.inReplyTo).toBe('m2@example.test');
    expect(message.references).toEqual(['m1@example.test', 'm2@example.test']);
  });

  it('warns missing-message-id when there is no Message-ID', async () => {
    const message = await parseOk(bytes('From: a@example.test\r\nDate: Tue, 3 Jun 2025 14:05:09 +0200\r\n\r\nx\r\n'));
    expect(message.messageId).toBeNull();
    expect(message.inReplyTo).toBeNull();
    expect(message.references).toEqual([]);
    expect(message.warnings).toEqual(['missing-message-id']);
  });

  it('reads the RAW Date header, so the sender offset is kept', async () => {
    const message = await parseOk(bytes(HEADERS, '\r\n\r\nx\r\n'));
    expect(message.date).toEqual({
      utcMs: Date.parse('2025-06-03T12:05:09Z'),
      original: 'Tue, 3 Jun 2025 14:05:09 +0200',
      offsetMinutes: 120,
      zoneKnown: true,
    });
  });

  it.each([
    ['no Date header', null, ['missing-date']],
    ['unparseable Date', 'Date: someday', ['unparseable-date']],
    ['"-0000" zone', 'Date: Tue, 3 Jun 2025 14:05:09 -0000', ['unknown-time-zone']],
  ] as const)('date warning: %s', async (_label, dateLine, warnings) => {
    const head = ['From: a@example.test', 'Message-ID: <d@example.test>', ...(dateLine ? [dateLine] : [])];
    const message = await parseOk(bytes(crlf(...head), '\r\n\r\nx\r\n'));
    expect(message.warnings).toEqual(warnings);
  });

  it('flattens address groups and keeps every From mailbox', async () => {
    const data = bytes(
      crlf(
        'From: Alice Example <alice@example.test>, bob@example.test',
        'To: Team: Carol Test <carol@example.test>, dave@example.test;, Erin <erin@example.test>',
        'Cc: Undisclosed recipients:;',
        'Date: Tue, 3 Jun 2025 14:05:09 +0200',
        'Message-ID: <a@example.test>',
      ),
      '\r\n\r\nx\r\n',
    );
    const message = await parseOk(data);
    expect(message.from).toEqual([
      { name: 'Alice Example', address: 'alice@example.test' },
      { name: '', address: 'bob@example.test' },
    ]);
    expect(message.to).toEqual([
      { name: 'Carol Test', address: 'carol@example.test' },
      { name: '', address: 'dave@example.test' },
      { name: 'Erin', address: 'erin@example.test' },
    ]);
    expect(message.cc).toEqual([]);
  });

  it('missing From/To/Cc/Subject become [] and ""; an empty Subject is "" too', async () => {
    const message = await parseOk(bytes('Date: Tue, 3 Jun 2025 14:05:09 +0200\r\nMessage-ID: <s@example.test>\r\n\r\nx\r\n'));
    expect(message.from).toEqual([]);
    expect(message.to).toEqual([]);
    expect(message.cc).toEqual([]);
    expect(message.subject).toBe('');
    const empty = await parseOk(bytes(HEADERS.replace('Subject: Test message', 'Subject:'), '\r\n\r\nx\r\n'));
    expect(empty.subject).toBe('');
  });
});

describe('createEmlParser: charsets', () => {
  it('reads raw 8-bit UTF-8 headers and body (RFC 6532)', async () => {
    const data = bytes(
      crlf(
        'From: Équipe Livraisons <equipe@example.test>',
        'To: bob@example.test',
        'Subject: Réunion – café à 9h €',
        'Date: Tue, 3 Jun 2025 14:05:09 +0200',
        'Message-ID: <u8@example.test>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
      ),
      '\r\n\r\nEén coördinatie, € 1.250, naïve.\r\n',
    );
    const message = await parseOk(data);
    expect(message.from).toEqual([{ name: 'Équipe Livraisons', address: 'equipe@example.test' }]);
    expect(message.subject).toBe('Réunion – café à 9h €');
    expect(message.bodyText).toContain('Eén coördinatie, € 1.250, naïve.');
  });

  it('decodes a windows-1252 8-bit body', async () => {
    // Only bytes outside 0x80-0x9F are asserted here: Node's TextDecoder maps
    // 0x80-0x9F of windows-1252 to C1 control characters, while browsers map
    // them correctly (0x80 is the euro sign, 0x93/0x94 curly quotes...).
    // That range is covered by the browser tests later.
    const data = bytes(
      crlf(
        'From: bob@example.test',
        'Date: Tue, 3 Jun 2025 14:05:09 +0200',
        'Message-ID: <w@example.test>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=windows-1252',
        'Content-Transfer-Encoding: 8bit',
      ),
      '\r\n\r\n',
      'caf',
      [0xe9], // é
      ' na',
      [0xef], // ï
      've, ',
      [0xe9],
      [0xe9],
      'n bureau\r\n',
    );
    const message = await parseOk(data);
    expect(message.bodyText).toContain('café naïve, één bureau');
  });
});

describe('createEmlParser: body', () => {
  const multipart = (boundary: string, ...parts: string[]): string =>
    `${parts.map((p) => `--${boundary}\r\n${p}\r\n`).join('')}--${boundary}--\r\n`;

  it('uses the text/plain part of multipart/alternative and never calls htmlToText', async () => {
    const htmlToText = vi.fn(stubHtmlToText);
    const data = bytes(
      HEADERS,
      '\r\nContent-Type: multipart/alternative; boundary="b1"\r\n\r\n',
      multipart(
        'b1',
        'Content-Type: text/plain; charset=utf-8\r\n\r\nPlain version.',
        'Content-Type: text/html; charset=utf-8\r\n\r\n<p>HTML <b>version</b></p>',
      ),
    );
    const result = await createEmlParser({ htmlToText }).parse({ name: 'alt.eml', bytes: data });
    expect(result.ok && result.message.bodyText).toContain('Plain version.');
    expect(result.ok && result.message.warnings).toEqual([]);
    expect(htmlToText).not.toHaveBeenCalled();
  });

  it('passes an HTML-only body to the injected htmlToText and warns html-only-body', async () => {
    const htmlToText = vi.fn(() => 'converted text');
    const html = '<p>Hello <script>window.SCRIPT_RAN = 1</script></p>';
    const data = bytes(HEADERS, '\r\nContent-Type: text/html; charset=utf-8\r\n\r\n', html, '\r\n');
    const result = await createEmlParser({ htmlToText }).parse({ name: 'html.eml', bytes: data });
    if (!result.ok) throw new Error(result.detail);
    expect(htmlToText).toHaveBeenCalledTimes(1);
    expect(htmlToText.mock.calls[0]).toEqual([`${html}\n`]);
    expect(result.message.bodyText).toBe('converted text');
    expect(result.message.warnings).toEqual(['html-only-body']);
  });

  it('a message with no body at all gives "" and no-body', async () => {
    const message = await parseOk(bytes(HEADERS, '\r\n\r\n'));
    expect(message.bodyText).toBe('');
    expect(message.warnings).toEqual(['no-body']);
  });
});

describe('createEmlParser: attachments (metadata only)', () => {
  const SECRET = 'ATTACHMENT-CONTENT-MUST-NOT-BE-KEPT';
  const FORWARDED = crlf('From: carol@example.test', 'Subject: Forwarded', '', 'Forwarded body.');
  const data = bytes(
    HEADERS,
    '\r\nContent-Type: multipart/mixed; boundary="mix"\r\n\r\n',
    crlf(
      '--mix',
      'Content-Type: multipart/related; boundary="rel"',
      '',
      '--rel',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Logo: <img src="cid:logo@example.test"></p>',
      '--rel',
      'Content-Type: image/png',
      'Content-ID: <logo@example.test>',
      'Content-Transfer-Encoding: base64',
      '',
      'AAECAwQ=',
      '--rel--',
      '--mix',
      'Content-Type: text/plain; name="note.txt"',
      'Content-Disposition: attachment; filename="note.txt"',
      '',
      SECRET,
      '--mix',
      'Content-Type: message/rfc822',
      'Content-Disposition: attachment; filename="forwarded.eml"',
      '',
      FORWARDED,
      '--mix',
      'Content-Type: application/octet-stream',
      'Content-Transfer-Encoding: base64',
      '',
      'AAAA',
      '--mix--',
      '',
    ),
  );

  it('lists every part with name, decoded size and type, and nothing else', async () => {
    const message = await parseOk(data);
    expect(message.attachments).toEqual([
      // Inline image of the HTML body (multipart/related): listed too.
      { fileName: '', size: 5, mimeType: 'image/png' },
      { fileName: 'note.txt', size: SECRET.length, mimeType: 'text/plain' },
      // A forwarded message sent AS an attachment stays an attachment.
      { fileName: 'forwarded.eml', size: FORWARDED.length, mimeType: 'message/rfc822' },
      // A part without a file name gets ''.
      { fileName: '', size: 3, mimeType: 'application/octet-stream' },
    ]);
    for (const attachment of message.attachments) {
      expect(Object.keys(attachment).sort()).toEqual(['fileName', 'mimeType', 'size']);
    }
    // Neither the attachment text nor the forwarded message body leaks into the result.
    const everything = JSON.stringify(message);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('Forwarded body.');
    // The HTML-only body went through htmlToText.
    expect(message.warnings).toEqual(['html-only-body']);
  });

  it('an inline forwarded message (no Content-Disposition) joins the body; its attachments are listed', async () => {
    const message = await parseOk(
      bytes(
        HEADERS,
        '\r\nContent-Type: multipart/mixed; boundary="fw"\r\n\r\n',
        crlf(
          '--fw',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'See the message below.',
          '--fw',
          'Content-Type: message/rfc822',
          '',
          'From: carol@example.test',
          'Subject: Inner',
          'Content-Type: multipart/mixed; boundary="in"',
          '',
          '--in',
          'Content-Type: text/plain',
          '',
          'Inner body text.',
          '--in',
          'Content-Type: text/plain; name="inner.txt"',
          'Content-Disposition: attachment; filename="inner.txt"',
          '',
          'abc',
          '--in--',
          '--fw--',
          '',
        ),
      ),
    );
    expect(message.bodyText).toContain('See the message below.');
    expect(message.bodyText).toContain('Inner body text.');
    expect(message.attachments).toEqual([{ fileName: 'inner.txt', size: 3, mimeType: 'text/plain' }]);
  });
});

describe('createEmlParser: inline forwarded messages', () => {
  /** An outer message: a text/plain part, then each given part. */
  const withParts = (outerText: string, ...parts: string[]): Uint8Array =>
    bytes(
      HEADERS,
      '\r\nContent-Type: multipart/mixed; boundary="fw"\r\n\r\n',
      ['--fw', 'Content-Type: text/plain; charset=utf-8', '', outerText, ...parts.flatMap((p) => ['--fw', p]), '--fw--', ''].join(
        '\r\n',
      ),
    );

  /** A message/rfc822 part (no Content-Disposition unless given). */
  const rfc822Part = (message: string, disposition?: string): string =>
    crlf('Content-Type: message/rfc822', ...(disposition ? [`Content-Disposition: ${disposition}`] : []), '', message);

  const INNER = crlf(
    'From: =?utf-8?Q?Caf=C3=A9_Owner?= <carol@example.test>',
    'Date: Mon, 2 Jun 2025 23:30:00 +0000',
    'Subject: =?utf-8?Q?R=C3=A9union?=',
    'To: Dave Test <dave@example.test>,',
    ' erin@example.test',
    'Cc: frank@example.test',
    'Message-ID: <inner@example.test>',
    '',
    'Inner body text.',
  );

  it('builds the header block from the RAW headers: the Date text is kept exactly, never reformatted', async () => {
    const message = await parseOk(withParts('See below.', rfc822Part(INNER)));
    // Exact text, so the result cannot depend on the machine locale or time zone.
    expect(message.bodyText).toBe(
      [
        'See below.',
        '',
        '---------- Forwarded message ----------',
        'From: Café Owner <carol@example.test>',
        'Date: Mon, 2 Jun 2025 23:30:00 +0000',
        'Subject: Réunion',
        'To: Dave Test <dave@example.test>, erin@example.test',
        'Cc: frank@example.test',
        '',
        'Inner body text.\n',
      ].join('\n'),
    );
    // No locale-formatted date such as 02/06/2025 or 6/3/2025 anywhere.
    expect(message.bodyText).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
    // The expanded message is in the body, so it is not listed as an attachment.
    expect(message.attachments).toEqual([]);
    expect(message.warnings).toEqual([]);
    // The outer message's own fields are untouched by the inner headers.
    expect(message.messageId).toBe('m1@example.test');
    expect(message.date.original).toBe('Tue, 3 Jun 2025 14:05:09 +0200');
  });

  it('"Content-Disposition: inline" is expanded the same way', async () => {
    const message = await parseOk(withParts('See below.', rfc822Part(INNER, 'inline')));
    expect(message.bodyText).toContain('Date: Mon, 2 Jun 2025 23:30:00 +0000\n');
    expect(message.bodyText).toContain('Inner body text.');
    expect(message.attachments).toEqual([]);
  });

  it('an HTML-only forwarded message goes through the injected htmlToText', async () => {
    const htmlToText = vi.fn<(html: string) => string>(() => 'converted inner text');
    const innerHtml = '<p>Inner <b>HTML</b></p>';
    const inner = crlf('From: carol@example.test', 'Date: Mon, 2 Jun 2025 23:30:00 +0000', 'Content-Type: text/html', '', innerHtml);
    const result = await createEmlParser({ htmlToText }).parse({
      name: 'fw.eml',
      bytes: withParts('Outer text.', rfc822Part(inner)),
    });
    if (!result.ok) throw new Error(result.detail);
    expect(htmlToText).toHaveBeenCalledTimes(1);
    expect(htmlToText.mock.calls[0]?.[0]).toContain(innerHtml);
    expect(result.message.bodyText).toContain('Outer text.');
    expect(result.message.bodyText).toContain('converted inner text');
    expect(result.message.bodyText).not.toContain('<b>');
    // Part of bodyText was converted from HTML: flagged like an HTML-only body.
    expect(result.message.warnings).toEqual(['html-only-body']);
  });

  /** A chain of `levels` forwarded messages: level 1 forwards level 2, which forwards level 3... */
  function chain(level: number, levels: number): string {
    const head = [
      `From: level${level}@example.test`,
      `Date: Mon, 2 Jun 2025 ${String(level).padStart(2, '0')}:00:00 +0000`,
      `Subject: Level ${level}`,
    ];
    if (level === levels) return crlf(...head, '', `Body of level ${level}.`);
    const b = `l${level}`;
    return crlf(
      ...head,
      `Content-Type: multipart/mixed; boundary="${b}"`,
      '',
      `--${b}`,
      'Content-Type: text/plain',
      '',
      `Body of level ${level}.`,
      `--${b}`,
      rfc822Part(chain(level + 1, levels)),
      `--${b}--`,
    );
  }

  it('nested forwarded messages (3 levels) appear in order, each with its own header block', async () => {
    const message = await parseOk(withParts('Outer text.', rfc822Part(chain(1, 3))));
    const order = [
      'Outer text.',
      'Subject: Level 1',
      'Body of level 1.',
      'Subject: Level 2',
      'Body of level 2.',
      'Subject: Level 3',
      'Body of level 3.',
    ].map((snippet) => message.bodyText.indexOf(snippet));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(message.bodyText.split('---------- Forwarded message ----------')).toHaveLength(4);
    expect(message.attachments).toEqual([]);
    expect(message.warnings).toEqual([]);
  });

  it('deeper than 5 levels: warns, lists the rest as an attachment, keeps levels 1-5 in the body', async () => {
    const level6 = chain(6, 7);
    const message = await parseOk(withParts('Outer text.', rfc822Part(chain(1, 7))));
    for (let level = 1; level <= 5; level++) expect(message.bodyText).toContain(`Body of level ${level}.`);
    expect(message.bodyText).not.toContain('Body of level 6.');
    expect(message.bodyText).not.toContain('Body of level 7.');
    expect(message.warnings).toEqual(['forwarded-message-not-expanded']);
    // Level 6 (which holds level 7) is listed with its decoded size, so it stays recoverable.
    expect(message.attachments).toEqual([{ fileName: '', size: level6.length, mimeType: 'message/rfc822' }]);
  });

  it('a message whose only content is a forwarded message has no no-body warning', async () => {
    const data = bytes(HEADERS, '\r\nContent-Type: message/rfc822\r\n\r\n', INNER);
    const message = await parseOk(data);
    expect(message.bodyText.startsWith('---------- Forwarded message ----------\n')).toBe(true);
    expect(message.bodyText).toContain('Inner body text.');
    expect(message.warnings).toEqual([]);
  });

  it('the original message inside a delivery report stays a listed attachment', async () => {
    const message = await parseOk(
      withParts(
        'Delivery failed.',
        crlf('Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; mx.example.test'),
        rfc822Part(INNER),
      ),
    );
    expect(message.bodyText).not.toContain('Inner body text.');
    expect(message.attachments.map((a) => a.mimeType)).toEqual(['message/delivery-status', 'message/rfc822']);
    expect(message.warnings).toEqual([]);
  });

  describe('a line break inside a decoded header becomes a space: no forged header line', () => {
    const ENCODED_SUBJECT = '=?utf-8?Q?line1=0D=0AFrom=3A_spoof@example.test?=';
    const inner = crlf(
      'From: carol@example.test',
      'Date: Mon, 2 Jun 2025 23:30:00 +0000',
      `Subject: ${ENCODED_SUBJECT}`,
      '',
      'Inner body text.',
    );

    async function forwardedHeaderLines(): Promise<string[]> {
      const message = await parseOk(withParts('See below.', rfc822Part(inner)));
      expect(message.bodyText).not.toMatch(/^From: spoof/m);
      const block = message.bodyText.slice(message.bodyText.indexOf('---------- Forwarded message ----------'));
      return block.slice(0, block.indexOf('\n\n')).split('\n');
    }

    it('with the real decoder (the encoded Subject holds "line1\\r\\nFrom: spoof@example.test")', async () => {
      const lines = await forwardedHeaderLines();
      expect(lines).toContain('Subject: line1 From: spoof@example.test');
      expect(lines.filter((line) => line.startsWith('From: spoof'))).toEqual([]);
    });

    // postal-mime 4.0.5 already turns CR and LF into spaces; these simulate a
    // version that does not, so the adapter's own guard is what is tested.
    it.each([
      ['CR LF', '\r\n'],
      ['a bare LF', '\n'],
      ['a bare CR', '\r'],
    ])('with a decoder that keeps %s (the adapter itself must remove it)', async (_label, lineBreak) => {
      const spy = vi.mocked(decodeWords);
      const real = spy.getMockImplementation();
      if (real === undefined) throw new Error('decodeWords spy has no implementation');
      spy.mockImplementation((value) =>
        value === ENCODED_SUBJECT ? `line1${lineBreak}From: spoof@example.test` : real(value),
      );
      try {
        const lines = await forwardedHeaderLines();
        expect(lines).toContain('Subject: line1 From: spoof@example.test');
        expect(lines.filter((line) => line.startsWith('From: spoof'))).toEqual([]);
      } finally {
        spy.mockImplementation(real);
      }
    });
  });

  it('the forwarded Date line is the raw header text, even when it looks like an encoded word', async () => {
    const inner = crlf('From: carol@example.test', 'Date: =?utf-8?Q?x?=', 'Subject: Inner', '', 'Inner body text.');
    const message = await parseOk(withParts('See below.', rfc822Part(inner)));
    expect(message.bodyText).toContain('\nDate: =?utf-8?Q?x?=\n');
  });

  it('an inner message that cannot be parsed is listed with its size and a warning', async () => {
    // Nested more than 64 multipart levels: over postal-mime's nesting limit,
    // so the second parse (of the inner bytes only) throws.
    let deep = 'Content-Type: text/plain\r\n\r\ndeep\r\n';
    for (let i = 0; i < 70; i++) {
      deep = `Content-Type: multipart/mixed; boundary="n${i}"\r\n\r\n--n${i}\r\n${deep}--n${i}--\r\n`;
    }
    const inner = `From: carol@example.test\r\nSubject: Too deep\r\n${deep}`;
    const result = await parse(withParts('Outer text.', rfc822Part(inner)));
    if (!result.ok) throw new Error(`expected ok, got ${result.error}: ${result.detail}`);
    expect(result.message.bodyText).toContain('Outer text.');
    expect(result.message.bodyText).not.toContain('---------- Forwarded message ----------');
    expect(result.message.attachments).toEqual([{ fileName: '', size: inner.length, mimeType: 'message/rfc822' }]);
    expect(result.message.warnings).toEqual(['forwarded-message-not-expanded']);
  });

  it('an inline forwarded message with no body, no headers and no attachments is listed, not added as an empty block', async () => {
    const inner = '\0\x01garbage no headers';
    const message = await parseOk(withParts('See below.', rfc822Part(inner)));
    expect(message.bodyText).toBe('See below.');
    expect(message.attachments).toEqual([{ fileName: '', size: inner.length, mimeType: 'message/rfc822' }]);
    expect(message.warnings).toEqual(['forwarded-message-not-expanded']);
  });

  it('a forwarded message with headers and only an attachment is expanded: header block shown, attachment listed', async () => {
    const pdf = 'JVBERi0xLjQKJSBzeW50aGV0aWMK'; // "%PDF-1.4\n% synthetic\n", 21 bytes
    const inner = crlf(
      'From: Desk Supplier <orders@example.test>',
      'Date: Wed, 4 Jun 2025 09:15:00 +0200',
      'Subject: Delivery of two office chairs',
      'To: frontdesk@example.test',
      'Content-Type: multipart/mixed; boundary="in"',
      '',
      '--in',
      'Content-Type: application/pdf; name="delivery-note.pdf"',
      'Content-Disposition: attachment; filename="delivery-note.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      pdf,
      '--in--',
    );
    const message = await parseOk(withParts('See below.', rfc822Part(inner)));
    expect(message.bodyText).toBe(
      [
        'See below.',
        '',
        '---------- Forwarded message ----------',
        'From: Desk Supplier <orders@example.test>',
        'Date: Wed, 4 Jun 2025 09:15:00 +0200',
        'Subject: Delivery of two office chairs',
        'To: frontdesk@example.test',
      ].join('\n'),
    );
    expect(message.attachments).toEqual([{ fileName: 'delivery-note.pdf', size: 21, mimeType: 'application/pdf' }]);
    expect(message.warnings).toEqual([]);
  });

  it('a forwarded message with headers only is expanded: header block shown, empty body, no warning', async () => {
    const inner = crlf(
      'From: Desk Supplier <orders@example.test>',
      'Date: Wed, 4 Jun 2025 09:15:00 +0200',
      'Subject: Filing cabinet',
      '',
      '',
    );
    const message = await parseOk(withParts('See below.', rfc822Part(inner)));
    expect(message.bodyText).toBe(
      [
        'See below.',
        '',
        '---------- Forwarded message ----------',
        'From: Desk Supplier <orders@example.test>',
        'Date: Wed, 4 Jun 2025 09:15:00 +0200',
        'Subject: Filing cabinet',
      ].join('\n'),
    );
    expect(message.attachments).toEqual([]);
    expect(message.warnings).toEqual([]);
  });

  it('at most 200 forwarded messages are expanded per file; the rest are listed', async () => {
    const inners = Array.from({ length: 201 }, (_, i) => crlf(`From: n${i + 1}@example.test`, '', `Body number ${i + 1}.`));
    const message = await parseOk(withParts('Outer text.', ...inners.map((inner) => rfc822Part(inner))));
    expect(message.bodyText.split('---------- Forwarded message ----------')).toHaveLength(201);
    expect(message.bodyText).toContain('Body number 200.');
    expect(message.bodyText).not.toContain('Body number 201.');
    const last = inners[200] ?? '';
    expect(message.attachments).toEqual([{ fileName: '', size: last.length, mimeType: 'message/rfc822' }]);
    expect(message.warnings).toEqual(['forwarded-message-not-expanded']);
  });
});

// Known limitation, to be replaced in 2.6: text/plain and a SEPARATE text/html
// part in multipart/mixed. postal-mime converts that HTML with its own regex
// converter and appends it to the text; the injected htmlToText is bypassed.
// And (P2) text parts that follow an inline forwarded message are placed
// before it. These tests pin today's output so any change is deliberate.
describe('createEmlParser: known limitation, to be replaced in 2.6', () => {
  const mixed = (...parts: string[]): Uint8Array =>
    bytes(HEADERS, '\r\nContent-Type: multipart/mixed; boundary="m"\r\n\r\n', crlf(...parts.flatMap((p) => ['--m', p]), '--m--', ''));

  it('P1: text/plain + text/html in multipart/mixed (htmlToText bypassed, style and link text leak)', async () => {
    const htmlToText = vi.fn(stubHtmlToText);
    const data = mixed(
      'Content-Type: text/plain\r\n\r\nPlain part.',
      'Content-Type: text/html\r\n\r\n<style>p{color:red}</style><p>HTML <a href="tracker.example.test/open?id=1">part</a></p>',
    );
    const result = await createEmlParser({ htmlToText }).parse({ name: 'p1.eml', bytes: data });
    if (!result.ok) throw new Error(result.detail);
    expect(result.message.bodyText).toBe('Plain part.\n p{color:red} \n\nHTML (tracker.example.test/open?id=1) part\n');
    expect(result.message.warnings).toEqual([]);
    expect(htmlToText).not.toHaveBeenCalled();
  });

  it('P1b: HTML main body + inline text/plain footer (no html-only-body warning)', async () => {
    const htmlToText = vi.fn(stubHtmlToText);
    const data = mixed(
      'Content-Type: text/html\r\n\r\n<p>Main HTML body.</p>',
      'Content-Type: text/plain\r\nContent-Disposition: inline\r\n\r\nFooter text.',
    );
    const result = await createEmlParser({ htmlToText }).parse({ name: 'p1b.eml', bytes: data });
    if (!result.ok) throw new Error(result.detail);
    expect(result.message.bodyText).toBe('\nMain HTML body.\n\nFooter text.');
    expect(result.message.warnings).toEqual([]);
    expect(htmlToText).not.toHaveBeenCalled();
  });

  it('P2: text parts after a forwarded message come before it (not file order)', async () => {
    const forward = (name: string): string =>
      crlf('Content-Type: message/rfc822', '', `From: ${name}@example.test`, `Subject: ${name}`, '', `Body of ${name}.`);
    const data = mixed(
      'Content-Type: text/plain\r\n\r\nT1',
      forward('fwa'),
      'Content-Type: text/plain\r\n\r\nT2 about FW-B below',
      forward('fwb'),
      'Content-Type: text/plain\r\n\r\nT3',
    );
    const message = await parseOk(data);
    // All outer text first, then FW-A, then FW-B. Nothing is lost, only moved.
    expect(message.bodyText).toBe(
      [
        'T1',
        'T2 about FW-B below',
        'T3',
        '',
        '---------- Forwarded message ----------',
        'From: fwa@example.test',
        'Subject: fwa',
        '',
        'Body of fwa.',
        '',
        '---------- Forwarded message ----------',
        'From: fwb@example.test',
        'Subject: fwb',
        '',
        'Body of fwb.\n',
      ].join('\n'),
    );
    expect(message.attachments).toEqual([]);
    expect(message.warnings).toEqual([]);
  });
});

describe('createEmlParser: malformed input never throws', () => {
  /** Deterministic pseudo-random bytes (a tiny LCG), so the test is repeatable. */
  function pseudoRandomBytes(length: number, seed: number): Uint8Array {
    const out = new Uint8Array(length);
    let state = seed;
    for (let i = 0; i < length; i++) {
      state = (state * 1103515245 + 12345) >>> 0;
      out[i] = state >>> 24;
    }
    return out;
  }

  /** Nested multiparts, `depth` levels deep. */
  function nested(depth: number): string {
    let body = 'Content-Type: text/plain\r\n\r\ndeep\r\n';
    for (let i = 0; i < depth; i++) {
      body = `Content-Type: multipart/mixed; boundary="n${i}"\r\n\r\n--n${i}\r\n${body}--n${i}--\r\n`;
    }
    return body;
  }

  const cases: [string, Uint8Array][] = [
    ['empty file', new Uint8Array()],
    ['random bytes', pseudoRandomBytes(4096, 42)],
    ['header-only message (no blank line)', bytes(HEADERS)],
    [
      'truncated multipart',
      bytes(HEADERS, '\r\nContent-Type: multipart/mixed; boundary="cut"\r\n\r\n--cut\r\nContent-Type: text/plain\r\n\r\nHalf a mess'),
    ],
    [
      'truncated base64 attachment',
      bytes(HEADERS, '\r\nContent-Type: multipart/mixed; boundary="c"\r\n\r\n--c\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n\r\nAAEC'),
    ],
    ['NUL bytes only', new Uint8Array(512)],
    ['NUL bytes in a header', bytes('From: a@example.test\r\nSubject: a', [0, 0], 'b\r\nX-Null: ', [0], '\r\n\r\nx\r\n')],
    [
      'invalid charset name',
      bytes(HEADERS, '\r\nContent-Type: text/plain; charset="no-such-charset-%%"\r\n\r\nPlain ASCII text.\r\n'),
    ],
    [
      'broken base64 body',
      bytes(HEADERS, '\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n!!not*base64==SGVsbG8=?=\r\n=\r\n'),
    ],
    [
      'broken quoted-printable body',
      bytes(HEADERS, '\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nBad =ZZ escape, =4 short, = \r\nend=\r\n'),
    ],
  ];

  it.each(cases)('%s', async (_label, data) => {
    const result = await parse(data, 'broken.eml');
    // Either outcome is fine; what matters is a result instead of an exception.
    if (result.ok) {
      expect(result.message.source.sha256).toBe(await sha256Hex(data));
    } else {
      expect(result).toMatchObject({ error: 'corrupt', fileName: 'broken.eml', sha256: await sha256Hex(data) });
    }
  });

  it('an invalid charset name still gives the ASCII text (best effort)', async () => {
    const data = bytes(HEADERS, '\r\nContent-Type: text/plain; charset="no-such-charset-%%"\r\n\r\nPlain ASCII text.\r\n');
    expect((await parseOk(data)).bodyText).toContain('Plain ASCII text.');
  });

  it('bare LF line endings are read like CRLF', async () => {
    const message = await parseOk(bytes(HEADERS.replaceAll('\r\n', '\n'), '\n\nHello.\nSecond line.\n'));
    expect(message.subject).toBe('Test message');
    expect(message.from).toEqual([{ name: 'Alice Example', address: 'alice@example.test' }]);
    expect(message.messageId).toBe('m1@example.test');
    expect(message.date.original).toBe('Tue, 3 Jun 2025 14:05:09 +0200');
    expect(message.bodyText).toBe('Hello.\nSecond line.\n');
    expect(message.warnings).toEqual([]);
  });

  it('a 3 MB header line is over the header size limit: corrupt, with the hash', async () => {
    const data = bytes(HEADERS, `\r\nX-Long: ${'a'.repeat(3 * 1024 * 1024)}\r\n\r\nx\r\n`);
    const result = await parse(data, 'long-header.eml');
    expect(result).toMatchObject({ ok: false, error: 'corrupt', sha256: await sha256Hex(data) });
    expect(!result.ok && result.detail).toMatch(/header size/i);
  });

  it('more than 2000 MIME parts is over the part limit: corrupt, with the hash', async () => {
    const parts = Array.from({ length: 2001 }, () => '--p\r\nContent-Type: text/plain\r\n\r\nx\r\n').join('');
    const data = bytes(HEADERS, '\r\nContent-Type: multipart/mixed; boundary="p"\r\n\r\n', parts, '--p--\r\n');
    const result = await parse(data, 'many-parts.eml');
    expect(result).toMatchObject({ ok: false, error: 'corrupt', sha256: await sha256Hex(data) });
    expect(!result.ok && result.detail).toMatch(/part count/i);
  });

  it('a header-only message is read, with no-body', async () => {
    const message = await parseOk(bytes(HEADERS));
    expect(message.subject).toBe('Test message');
    expect(message.warnings).toEqual(['no-body']);
  });

  it('too deeply nested multiparts are reported as corrupt, with the hash', async () => {
    const data = bytes(HEADERS, '\r\n', nested(100));
    const result = await parse(data, 'deep.eml');
    expect(result).toMatchObject({ ok: false, error: 'corrupt', fileName: 'deep.eml', sha256: await sha256Hex(data) });
    expect(!result.ok && result.detail.length).toBeGreaterThan(0);
  });

  it('a failing htmlToText becomes a corrupt result, not an exception', async () => {
    const failing = createEmlParser({
      htmlToText: () => {
        throw new Error('converter failed');
      },
    });
    const data = bytes(HEADERS, '\r\nContent-Type: text/html\r\n\r\n<p>x</p>\r\n');
    const result = await failing.parse({ name: 'h.eml', bytes: data });
    expect(result).toEqual({
      ok: false,
      error: 'corrupt',
      detail: 'converter failed',
      fileName: 'h.eml',
      sha256: await sha256Hex(data),
    });
  });
});
