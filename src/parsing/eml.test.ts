// Unit tests for the .eml adapter. Every message is built in memory from
// synthetic text and bytes (README.md, rule R7); nothing is read from disk.

import { decodeWords } from 'postal-mime';
import { describe, expect, it, vi } from 'vitest';
import { createEmlParser } from './eml';
import { sha256Hex } from './hash';
import type { HtmlToTextResult } from './html-to-text';
import type { EmailParser, NormalizedMessage, ParseResult } from './types';

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
const stubHtmlToText = (html: string): HtmlToTextResult => ({ text: `[stub] ${html.length}`, truncated: false });
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

describe('createEmlParser: Sender ("on behalf of") and Bcc', () => {
  const withHeaders = (...extra: string[]): Uint8Array =>
    bytes(HEADERS, extra.length > 0 ? `\r\n${crlf(...extra)}` : '', '\r\n\r\nx\r\n');

  it('keeps a Sender whose address is not a From address', async () => {
    const message = await parseOk(withHeaders('Sender: Carol Test <carol@example.test>'));
    expect(message.from).toEqual([{ name: 'Alice Example', address: 'alice@example.test' }]);
    expect(message.sender).toEqual({ name: 'Carol Test', address: 'carol@example.test' });
  });

  it('no sender key at all when there is no Sender header, or it is empty', async () => {
    expect('sender' in (await parseOk(withHeaders()))).toBe(false);
    expect('sender' in (await parseOk(withHeaders('Sender:   ')))).toBe(false);
  });

  it('no sender key when the Sender names a From mailbox, letter case and display name ignored', async () => {
    expect('sender' in (await parseOk(withHeaders('Sender: "A. Example" <ALICE@Example.Test>')))).toBe(false);
    const twoAuthors = bytes(
      HEADERS.replace('From: Alice Example <alice@example.test>', 'From: Alice Example <alice@example.test>, bob@example.test'),
      '\r\nSender: bob@example.test\r\n\r\nx\r\n',
    );
    expect('sender' in (await parseOk(twoAuthors))).toBe(false);
  });

  it('keeps the Sender when there is no From header', async () => {
    const noFrom = bytes(
      HEADERS.replace('From: Alice Example <alice@example.test>\r\n', ''),
      '\r\nSender: Carol Test <carol@example.test>\r\n\r\nx\r\n',
    );
    const message = await parseOk(noFrom);
    expect(message.from).toEqual([]);
    expect(message.sender).toEqual({ name: 'Carol Test', address: 'carol@example.test' });
  });

  it('a malformed Sender with several mailboxes gives its first (groups flattened, encoded words decoded)', async () => {
    const message = await parseOk(withHeaders('Sender: Desk: =?utf-8?Q?Caf=C3=A9_Desk?= <desk@example.test>, other@example.test;'));
    expect(message.sender).toEqual({ name: 'Café Desk', address: 'desk@example.test' });
  });

  it('reads every mailbox of every Bcc header, groups flattened; [] without one', async () => {
    const message = await parseOk(
      withHeaders('Bcc: Carol Test <carol@example.test>,', ' Team: dave@example.test;', 'Bcc: erin@example.test'),
    );
    expect(message.bcc).toEqual([
      { name: 'Carol Test', address: 'carol@example.test' },
      { name: '', address: 'dave@example.test' },
      { name: '', address: 'erin@example.test' },
    ]);
    expect((await parseOk(withHeaders())).bcc).toEqual([]);
    expect((await parseOk(withHeaders('Bcc:'))).bcc).toEqual([]);
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

  it('passes an HTML-only body to the injected htmlToText and warns html-converted-body', async () => {
    const htmlToText = vi.fn(() => ({ text: 'converted text', truncated: false }));
    const html = '<p>Hello <script>window.SCRIPT_RAN = 1</script></p>';
    const data = bytes(HEADERS, '\r\nContent-Type: text/html; charset=utf-8\r\n\r\n', html, '\r\n');
    const result = await createEmlParser({ htmlToText }).parse({ name: 'html.eml', bytes: data });
    if (!result.ok) throw new Error(result.detail);
    expect(htmlToText).toHaveBeenCalledTimes(1);
    expect(htmlToText.mock.calls[0]).toEqual([`${html}\n`]);
    expect(result.message.bodyText).toBe('converted text');
    expect(result.message.warnings).toEqual(['html-converted-body']);
  });

  it('a converter result cut at its length limit adds html-body-truncated (the note stays in the text)', async () => {
    const htmlToText = (): HtmlToTextResult => ({ text: 'start\n\n[Text cut here: ...]', truncated: true });
    const data = bytes(HEADERS, '\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>long</p>\r\n');
    const result = await createEmlParser({ htmlToText }).parse({ name: 'cut.eml', bytes: data });
    if (!result.ok) throw new Error(result.detail);
    expect(result.message.bodyText).toBe('start\n\n[Text cut here: ...]');
    expect(result.message.warnings).toEqual(['html-converted-body', 'html-body-truncated']);
  });

  it('a message with no body at all gives "" and no-body', async () => {
    const message = await parseOk(bytes(HEADERS, '\r\n\r\n'));
    expect(message.bodyText).toBe('');
    expect(message.warnings).toEqual(['no-body']);
  });
});

describe('createEmlParser: line ends in bodyText are LF only (only CR is changed)', () => {
  /** A single text/plain body, written as given (8bit, so a lone CR reaches postal-mime as is). */
  const plainBody = (body: string): Uint8Array =>
    bytes(HEADERS, '\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n', body);

  it('a lone CR inside a line becomes LF (postal-mime itself keeps it)', async () => {
    const message = await parseOk(plainBody('line one\rline two\r\n'));
    expect(message.bodyText).toBe('line one\nline two\n');
  });

  it('CRLF becomes LF', async () => {
    const message = await parseOk(plainBody('one\r\ntwo\r\n\r\nthree\r\n'));
    expect(message.bodyText).toBe('one\ntwo\n\nthree\n');
  });

  it('mixed CRLF, lone CR, doubled CR and LF all become LF', async () => {
    const message = await parseOk(plainBody('a\rb\r\nc\nd\r\re\r\n'));
    expect(message.bodyText).toBe('a\nb\nc\nd\n\ne\n');
  });

  it('a CR at the very end of the file becomes LF', async () => {
    const message = await parseOk(plainBody('last line\r'));
    expect(message.bodyText).toBe('last line\n');
  });

  it('a CR from quoted-printable (=0D) becomes LF; other characters stay as they are', async () => {
    const data = bytes(
      HEADERS,
      '\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n',
      'caf=C3=A9=0Dna=C3=AFve\t=E2=80=A8end\r\n',
    );
    const message = await parseOk(data);
    expect(message.bodyText).toBe('café\nnaïve\t\u2028end\n');
  });

  it('converted HTML text with CR becomes LF', async () => {
    const htmlToText = (): HtmlToTextResult => ({ text: 'a\rb\r\nc', truncated: false });
    const data = bytes(HEADERS, '\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>x</p>\r\n');
    const result = await createEmlParser({ htmlToText }).parse({ name: 'html.eml', bytes: data });
    if (!result.ok) throw new Error(result.detail);
    expect(result.message.bodyText).toBe('a\nb\nc');
  });

  it('in an inline forwarded message, and before its block: the blank line around the block stays one blank line', async () => {
    const inner = crlf('From: carol@example.test', 'Subject: Inner', 'Content-Type: text/plain', '', 'inner one\rinner two\r');
    const data = bytes(
      HEADERS,
      '\r\nContent-Type: multipart/mixed; boundary="fw"\r\n\r\n',
      crlf(
        '--fw',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'outer one\router two\r',
        '--fw',
        'Content-Type: message/rfc822',
        '',
        inner,
        '--fw--',
        '',
      ),
    );
    const message = await parseOk(data);
    expect(message.bodyText).toBe(
      [
        'outer one',
        'outer two',
        '',
        '---------- Forwarded message ----------',
        'From: carol@example.test',
        'Subject: Inner',
        '',
        'inner one',
        'inner two',
        '',
      ].join('\n'),
    );
  });

  it('the SHA-256 is still the one of the file bytes', async () => {
    const data = plainBody('one\rtwo\r\n');
    const result = await parse(data);
    if (!result.ok) throw new Error(result.detail);
    expect(result.message.source.sha256).toBe(await sha256Hex(data));
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
    const result = await parse(data);
    if (!result.ok) throw new Error(result.detail);
    const { message } = result;
    expect(message.attachments).toEqual([
      // Inline image of the HTML body (multipart/related): listed too.
      { fileName: '', size: 5, mimeType: 'image/png' },
      { fileName: 'note.txt', size: SECRET.length, mimeType: 'text/plain' },
      // A forwarded message sent AS an attachment stays a listed attachment
      // of this email (it is also read on its own, see below).
      { fileName: 'forwarded.eml', size: FORWARDED.length, mimeType: 'message/rfc822' },
      // A part without a file name gets ''.
      { fileName: '', size: 3, mimeType: 'application/octet-stream' },
    ]);
    for (const attachment of message.attachments) {
      expect(Object.keys(attachment).sort()).toEqual(['fileName', 'mimeType', 'size']);
    }
    // Neither the attachment text nor the forwarded message body leaks into this email.
    expect(JSON.stringify(message)).not.toContain(SECRET);
    expect(JSON.stringify(message)).not.toContain('Forwarded body.');
    // The HTML-only body went through htmlToText.
    expect(message.warnings).toEqual(['html-converted-body']);
    // The attached email (user decision 2026-11-10) becomes an email of its
    // own, printed nowhere (places []). The other attachment's text is never read.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.attached).toHaveLength(1);
    const forwarded = result.attached?.[0];
    expect(forwarded?.parent).toBe(-1);
    expect(forwarded?.places).toEqual([]);
    expect(forwarded?.path).toEqual([1]);
    expect(forwarded?.message.subject).toBe('Forwarded');
    expect(forwarded?.message.bodyText).toBe('Forwarded body.\n');
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
    // Marked as belonging to the attached email at index 0.
    expect(message.attachments).toEqual([{ fileName: 'inner.txt', size: 3, mimeType: 'text/plain', attachedIndex: 0 }]);
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
    const htmlToText = vi.fn<(html: string) => HtmlToTextResult>(() => ({ text: 'converted inner text', truncated: false }));
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
    expect(result.message.warnings).toEqual(['html-converted-body']);
  });

  it('a truncated HTML-only forwarded message passes html-body-truncated up to the outer message', async () => {
    const htmlToText = (): HtmlToTextResult => ({ text: 'cut inner text', truncated: true });
    const inner = crlf('From: carol@example.test', 'Content-Type: text/html', '', '<p>Inner</p>');
    const result = await createEmlParser({ htmlToText }).parse({
      name: 'fw-cut.eml',
      bytes: withParts('Outer text.', rfc822Part(inner)),
    });
    if (!result.ok) throw new Error(result.detail);
    expect(result.message.bodyText).toContain('cut inner text');
    expect(result.message.warnings).toEqual(['html-converted-body', 'html-body-truncated']);
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
    // Level 6 (which holds level 7) is listed with its decoded size, so it
    // stays recoverable. It is an attachment of level 5 (attached email 4).
    expect(message.attachments).toEqual([{ fileName: '', size: level6.length, mimeType: 'message/rfc822', attachedIndex: 4 }]);
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

  it('the header block lists a differing Sender after From, and Bcc after Cc', async () => {
    const inner = crlf(
      'From: Carol Test <carol@example.test>',
      'Sender: =?utf-8?Q?Caf=C3=A9_Desk?= <desk@example.test>',
      'Date: Mon, 2 Jun 2025 23:30:00 +0000',
      'Subject: Inner',
      'To: dave@example.test',
      'Bcc: erin@example.test,',
      ' frank@example.test',
      '',
      'Inner body text.',
    );
    const message = await parseOk(withParts('See below.', rfc822Part(inner)));
    expect(message.bodyText).toContain(
      [
        '---------- Forwarded message ----------',
        'From: Carol Test <carol@example.test>',
        'Sender: Café Desk <desk@example.test>',
        'Date: Mon, 2 Jun 2025 23:30:00 +0000',
        'Subject: Inner',
        'To: dave@example.test',
        'Bcc: erin@example.test, frank@example.test',
        '',
        'Inner body text.',
      ].join('\n'),
    );
    // The inner Sender and Bcc do not become the outer message's.
    expect('sender' in message).toBe(false);
    expect(message.bcc).toEqual([]);
  });

  it('the header block has no Sender line when the Sender is a From mailbox, and no line for an empty Bcc', async () => {
    const inner = crlf(
      'From: Carol Test <carol@example.test>',
      'Sender: CAROL@example.test',
      'Date: Mon, 2 Jun 2025 23:30:00 +0000',
      'Bcc:',
      '',
      'Inner body text.',
    );
    const message = await parseOk(withParts('See below.', rfc822Part(inner)));
    expect(message.bodyText).not.toContain('Sender:');
    expect(message.bodyText).not.toContain('Bcc:');
    expect(message.bodyText).toContain('From: Carol Test <carol@example.test>\nDate: Mon, 2 Jun 2025 23:30:00 +0000\n\nInner body text.');
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
    expect(message.attachments).toEqual([
      { fileName: 'delivery-note.pdf', size: 21, mimeType: 'application/pdf', attachedIndex: 0 },
    ]);
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

// The body is built part by part from the MIME tree, in file order, and every
// HTML part goes through the injected htmlToText. postal-mime's own joined
// text (and its own HTML-to-text conversion) is never used.
describe('createEmlParser: body built from the MIME parts tree', () => {
  const mixed = (...parts: string[]): Uint8Array =>
    bytes(HEADERS, '\r\nContent-Type: multipart/mixed; boundary="m"\r\n\r\n', crlf(...parts.flatMap((p) => ['--m', p]), '--m--', ''));

  /** A spy converter: records every HTML string and returns "[html N]". */
  function spyConverter(): { htmlToText: (html: string) => HtmlToTextResult; calls: string[] } {
    const calls: string[] = [];
    return { calls, htmlToText: (html) => ({ text: `[html ${String(calls.push(html))}]`, truncated: false }) };
  }

  async function parseWith(data: Uint8Array, htmlToText: (html: string) => HtmlToTextResult): Promise<NormalizedMessage> {
    const result = await createEmlParser({ htmlToText }).parse({ name: 'tree.eml', bytes: data });
    if (!result.ok) throw new Error(result.detail);
    return result.message;
  }

  const STYLED_HTML = '<style>p{color:red}</style><p>HTML <a href="tracker.example.invalid/open?id=1">part</a></p>';

  it('P1: text/plain + text/html in multipart/mixed: the HTML goes through htmlToText, in file order', async () => {
    const spy = spyConverter();
    const message = await parseWith(
      mixed('Content-Type: text/plain\r\n\r\nPlain part.', `Content-Type: text/html\r\n\r\n${STYLED_HTML}`),
      spy.htmlToText,
    );
    expect(spy.calls).toEqual([STYLED_HTML]);
    expect(message.bodyText).toBe('Plain part.\n[html 1]');
    // Nothing from postal-mime's own converter: no style contents, no link target.
    expect(message.bodyText).not.toContain('color');
    expect(message.bodyText).not.toContain('tracker');
    expect(message.warnings).toEqual(['html-converted-body']);
  });

  it('P1b: HTML main body + inline text/plain footer: both in order, html-converted-body', async () => {
    const spy = spyConverter();
    const message = await parseWith(
      mixed(
        'Content-Type: text/html\r\n\r\n<p>Main HTML body.</p>',
        'Content-Type: text/plain\r\nContent-Disposition: inline\r\n\r\nFooter text.',
      ),
      spy.htmlToText,
    );
    expect(spy.calls).toEqual(['<p>Main HTML body.</p>']);
    expect(message.bodyText).toBe('[html 1]\nFooter text.');
    expect(message.warnings).toEqual(['html-converted-body']);
  });

  it('P2: text parts and inline forwarded messages stay in file order', async () => {
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
    expect(message.bodyText).toBe(
      [
        'T1',
        '',
        '---------- Forwarded message ----------',
        'From: fwa@example.test',
        'Subject: fwa',
        '',
        'Body of fwa.',
        '',
        'T2 about FW-B below',
        '',
        '---------- Forwarded message ----------',
        'From: fwb@example.test',
        'Subject: fwb',
        '',
        'Body of fwb.',
        '',
        'T3',
      ].join('\n'),
    );
    expect(message.attachments).toEqual([]);
    expect(message.warnings).toEqual([]);
  });

  it('every HTML part of a multipart/mixed is converted, each once, in order', async () => {
    const spy = spyConverter();
    const message = await parseWith(
      mixed(
        'Content-Type: text/html\r\n\r\n<p>first</p>',
        'Content-Type: text/plain\r\n\r\nmiddle',
        'Content-Type: text/html\r\n\r\n<p>second</p>',
      ),
      spy.htmlToText,
    );
    expect(spy.calls).toEqual(['<p>first</p>', '<p>second</p>']);
    expect(message.bodyText).toBe('[html 1]\nmiddle\n[html 2]');
    expect(message.warnings).toEqual(['html-converted-body']);
  });

  it('an HTML part in multipart/related next to a text part is converted; its image is listed', async () => {
    const spy = spyConverter();
    const message = await parseWith(
      mixed(
        'Content-Type: text/plain\r\n\r\nIntro.',
        crlf(
          'Content-Type: multipart/related; boundary="r"',
          '',
          '--r',
          'Content-Type: text/html',
          '',
          '<p><img src="cid:i@example.test"></p>',
          '--r',
          'Content-Type: image/png',
          'Content-ID: <i@example.test>',
          'Content-Transfer-Encoding: base64',
          '',
          'AAECAwQ=',
          '--r--',
        ),
      ),
      spy.htmlToText,
    );
    expect(spy.calls).toEqual(['<p><img src="cid:i@example.test"></p>']);
    expect(message.bodyText).toBe('Intro.\n[html 1]');
    expect(message.attachments).toEqual([{ fileName: '', size: 5, mimeType: 'image/png' }]);
  });

  it('a cut HTML part in multipart/mixed adds html-body-truncated', async () => {
    const htmlToText = (): HtmlToTextResult => ({ text: 'cut [Text cut here: ...]', truncated: true });
    const message = await parseWith(
      mixed('Content-Type: text/plain\r\n\r\nPlain.', 'Content-Type: text/html\r\n\r\n<p>long</p>'),
      htmlToText,
    );
    expect(message.bodyText).toBe('Plain.\ncut [Text cut here: ...]');
    expect(message.warnings).toEqual(['html-converted-body', 'html-body-truncated']);
  });

  describe('multipart/alternative: plain text of every version, or one HTML version', () => {
    const alternative = (...parts: string[]): string =>
      crlf('Content-Type: multipart/alternative; boundary="a"', '', ...parts.flatMap((p) => ['--a', p]), '--a--');

    it('keeps the plain version, even a short stub, and never converts the HTML', async () => {
      const spy = spyConverter();
      const message = await parseWith(
        mixed(
          alternative(
            'Content-Type: text/plain\r\n\r\nView this message in a browser.',
            `Content-Type: text/html\r\n\r\n${STYLED_HTML}`,
          ),
        ),
        spy.htmlToText,
      );
      expect(spy.calls).toEqual([]);
      expect(message.bodyText).toBe('View this message in a browser.');
      expect(message.warnings).toEqual([]);
    });

    it('uses the HTML version when the plain version is empty', async () => {
      const spy = spyConverter();
      const message = await parseWith(
        mixed(alternative('Content-Type: text/plain\r\n', 'Content-Type: text/html\r\n\r\n<p>Only real text.</p>')),
        spy.htmlToText,
      );
      expect(spy.calls).toEqual(['<p>Only real text.</p>']);
      expect(message.bodyText).toBe('[html 1]');
      expect(message.warnings).toEqual(['html-converted-body']);
    });

    it('the plain version wins even when it comes after the HTML version', async () => {
      const spy = spyConverter();
      const message = await parseWith(
        mixed(alternative('Content-Type: text/html\r\n\r\n<p>HTML first</p>', 'Content-Type: text/plain\r\n\r\nPlain second.')),
        spy.htmlToText,
      );
      expect(spy.calls).toEqual([]);
      expect(message.bodyText).toBe('Plain second.');
    });

    it('plain-only version present: no HTML converted; attachments in every version are still listed', async () => {
      const spy = spyConverter();
      const message = await parseWith(
        mixed(
          'Content-Type: text/plain\r\n\r\nBefore.',
          alternative(
            'Content-Type: text/plain\r\n\r\nPlain version.',
            crlf(
              'Content-Type: multipart/mixed; boundary="in"',
              '',
              '--in',
              'Content-Type: text/html',
              '',
              '<p>HTML version.</p>',
              '--in',
              'Content-Type: application/pdf; name="only-in-html.pdf"',
              'Content-Transfer-Encoding: base64',
              '',
              'AAAA',
              '--in--',
            ),
          ),
          'Content-Type: text/plain\r\n\r\nAfter.',
        ),
        spy.htmlToText,
      );
      expect(spy.calls).toEqual([]);
      expect(message.bodyText).toBe('Before.\nPlain version.\nAfter.');
      // An attachment inside the version that was not chosen is still listed.
      expect(message.attachments).toEqual([{ fileName: 'only-in-html.pdf', size: 3, mimeType: 'application/pdf' }]);
    });

    /** A message whose whole body is one multipart/alternative. */
    const alternativeOnly = (...parts: string[]): Uint8Array => bytes(HEADERS, '\r\n', alternative(...parts), '\r\n');

    /** A multipart/mixed part (boundary "in") holding `parts`, to nest inside a version. */
    const innerMixed = (...parts: string[]): string =>
      crlf('Content-Type: multipart/mixed; boundary="in"', '', ...parts.flatMap((p) => ['--in', p]), '--in--');

    it('Apple Mail shape: the inline text/plain inside the HTML version is kept (never deleted)', async () => {
      const spy = spyConverter();
      const message = await parseWith(
        alternativeOnly(
          'Content-Type: text/plain\r\n\r\nHi, notes attached.',
          innerMixed(
            'Content-Type: text/html\r\n\r\n<p>Hi, notes attached.</p>',
            'Content-Type: text/plain; name="notes.txt"\r\nContent-Disposition: inline; filename="notes.txt"\r\n\r\nNOTES FILE CONTENT',
            'Content-Type: text/html\r\n\r\n<p>end</p>',
          ),
        ),
        spy.htmlToText,
      );
      expect(spy.calls).toEqual([]);
      expect(message.bodyText).toBe('Hi, notes attached.\nNOTES FILE CONTENT');
      expect(message.attachments).toEqual([]);
      expect(message.warnings).toEqual([]);
    });

    it('a plain footer inside the HTML version is kept after the plain version', async () => {
      const spy = spyConverter();
      const message = await parseWith(
        alternativeOnly(
          'Content-Type: text/plain\r\n\r\nPlain version.',
          innerMixed(
            'Content-Type: text/html\r\n\r\n<p>HTML version.</p>',
            'Content-Type: text/plain\r\nContent-Disposition: inline\r\n\r\nFooter text.',
          ),
        ),
        spy.htmlToText,
      );
      expect(spy.calls).toEqual([]);
      expect(message.bodyText).toBe('Plain version.\nFooter text.');
      expect(message.warnings).toEqual([]);
    });

    it('HTML-only alternative: only the first HTML version is converted; the others are other renderings', async () => {
      const spy = spyConverter();
      const message = await parseWith(
        alternativeOnly(
          'Content-Type: text/html\r\n\r\n<p>First rendering.</p>',
          innerMixed(
            'Content-Type: text/html\r\n\r\n<p>Second rendering.</p>',
            'Content-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAwQ=',
          ),
          'Content-Type: text/html\r\n\r\n<p>Third rendering.</p>',
        ),
        spy.htmlToText,
      );
      expect(spy.calls).toEqual(['<p>First rendering.</p>']);
      expect(message.bodyText).toBe('[html 1]');
      expect(message.attachments).toEqual([{ fileName: '', size: 5, mimeType: 'image/png' }]);
      expect(message.warnings).toEqual(['html-converted-body']);
    });

    // The inner alternative holds HTML too, so it is not a plain-only version:
    // the outer HTML is converted, and the inner plain text is still kept.
    // That repeats the content, but duplication is preferred to loss (README.md,
    // rule R6): a plain part next to HTML must never hide the HTML main body.
    it('nested alternatives: outer HTML converted and inner plain kept (duplication, not loss)', async () => {
      const spy = spyConverter();
      const message = await parseWith(
        alternativeOnly(
          'Content-Type: text/html\r\n\r\n<p>Outer HTML.</p>',
          crlf(
            'Content-Type: multipart/alternative; boundary="a2"',
            '',
            '--a2',
            'Content-Type: text/plain',
            '',
            'Inner plain.',
            '--a2',
            'Content-Type: text/html',
            '',
            '<p>Inner HTML.</p>',
            '--a2--',
          ),
        ),
        spy.htmlToText,
      );
      expect(spy.calls).toEqual(['<p>Outer HTML.</p>']);
      expect(message.bodyText).toBe('[html 1]\nInner plain.');
      expect(message.warnings).toEqual(['html-converted-body']);
    });

    // Regressions: plain text that is not a plain rendering of the message
    // (whitespace only, or an inline part next to HTML in the same version)
    // must never hide the HTML main body (README.md, rule R6).
    it('a whitespace-only plain version does not hide the HTML version', async () => {
      const spy = spyConverter();
      const message = await parseWith(
        alternativeOnly('Content-Type: text/plain\r\n\r\n   \r\n  ', 'Content-Type: text/html\r\n\r\n<p>REAL HTML CONTENT</p>'),
        spy.htmlToText,
      );
      expect(spy.calls).toEqual(['<p>REAL HTML CONTENT</p>']);
      // The whitespace part is still appended, as any plain part: harmless, nothing dropped.
      expect(message.bodyText).toBe('   \n  \n[html 1]');
      expect(message.warnings).toEqual(['html-converted-body']);
    });

    it('HTML-only first version + a version with HTML and inline notes: V1 converted, notes kept', async () => {
      const spy = spyConverter();
      const message = await parseWith(
        alternativeOnly(
          'Content-Type: text/html\r\n\r\n<p>MAIN HTML V1</p>',
          innerMixed(
            'Content-Type: text/html\r\n\r\n<p>MAIN HTML V2</p>',
            'Content-Type: text/plain; name="notes.txt"\r\nContent-Disposition: inline; filename="notes.txt"\r\n\r\nINLINE NOTES',
          ),
        ),
        spy.htmlToText,
      );
      expect(spy.calls).toEqual(['<p>MAIN HTML V1</p>']);
      expect(message.bodyText).toBe('[html 1]\nINLINE NOTES');
      expect(message.attachments).toEqual([]);
      expect(message.warnings).toEqual(['html-converted-body']);
    });

    it('HTML-only first version + related{html, plain}: V1 converted, the plain text kept', async () => {
      const spy = spyConverter();
      const message = await parseWith(
        alternativeOnly(
          'Content-Type: text/html\r\n\r\n<p>HTML ONLY V1</p>',
          crlf(
            'Content-Type: multipart/related; boundary="r"',
            '',
            '--r',
            'Content-Type: text/html',
            '',
            '<p>HTML V2</p>',
            '--r',
            'Content-Type: text/plain',
            '',
            'PLAIN IN RELATED',
            '--r--',
          ),
        ),
        spy.htmlToText,
      );
      expect(spy.calls).toEqual(['<p>HTML ONLY V1</p>']);
      expect(message.bodyText).toBe('[html 1]\nPLAIN IN RELATED');
      expect(message.warnings).toEqual(['html-converted-body']);
    });

    it('alternative{related{html, image}, plain}: the plain text, the image listed', async () => {
      const spy = spyConverter();
      const message = await parseWith(
        alternativeOnly(
          crlf(
            'Content-Type: multipart/related; boundary="r"',
            '',
            '--r',
            'Content-Type: text/html',
            '',
            '<p>Related HTML.</p>',
            '--r',
            'Content-Type: image/png',
            'Content-Transfer-Encoding: base64',
            '',
            'AAECAwQ=',
            '--r--',
          ),
          'Content-Type: text/plain\r\n\r\nPlain rendering.',
        ),
        spy.htmlToText,
      );
      expect(spy.calls).toEqual([]);
      expect(message.bodyText).toBe('Plain rendering.');
      expect(message.attachments).toEqual([{ fileName: '', size: 5, mimeType: 'image/png' }]);
      expect(message.warnings).toEqual([]);
    });

    it('inside a forwarded message, the same rule applies: HTML main body + inline notes both kept', async () => {
      const spy = spyConverter();
      const inner = crlf(
        'From: carol@example.test',
        'Subject: Inner',
        'Content-Type: multipart/alternative; boundary="a"',
        '',
        '--a',
        'Content-Type: text/html',
        '',
        '<p>FORWARDED HTML V1</p>',
        '--a',
        innerMixed(
          'Content-Type: text/html\r\n\r\n<p>FORWARDED HTML V2</p>',
          'Content-Type: text/plain\r\nContent-Disposition: inline\r\n\r\nFORWARDED NOTES',
        ),
        '--a--',
      );
      const message = await parseWith(
        mixed('Content-Type: text/plain\r\n\r\nOuter.', crlf('Content-Type: message/rfc822', '', inner)),
        spy.htmlToText,
      );
      expect(spy.calls).toEqual(['<p>FORWARDED HTML V1</p>']);
      expect(message.bodyText).toBe(
        [
          'Outer.',
          '',
          '---------- Forwarded message ----------',
          'From: carol@example.test',
          'Subject: Inner',
          '',
          '[html 1]',
          'FORWARDED NOTES',
        ].join('\n'),
      );
      expect(message.warnings).toEqual(['html-converted-body']);
    });

    it('nested HTML-only alternatives: only the first HTML of the first version is converted', async () => {
      const spy = spyConverter();
      const message = await parseWith(
        alternativeOnly(
          crlf(
            'Content-Type: multipart/alternative; boundary="a2"',
            '',
            '--a2',
            'Content-Type: text/html',
            '',
            '<p>Inner first.</p>',
            '--a2',
            'Content-Type: text/html',
            '',
            '<p>Inner second.</p>',
            '--a2--',
          ),
          'Content-Type: text/html\r\n\r\n<p>Outer second.</p>',
        ),
        spy.htmlToText,
      );
      expect(spy.calls).toEqual(['<p>Inner first.</p>']);
      expect(message.bodyText).toBe('[html 1]');
      expect(message.warnings).toEqual(['html-converted-body']);
    });

    it('plain beside a nested HTML-only alternative: the plain is used, the nested HTML stays hidden', async () => {
      const spy = spyConverter();
      const message = await parseWith(
        alternativeOnly(
          'Content-Type: text/plain\r\n\r\nP',
          crlf(
            'Content-Type: multipart/alternative; boundary="a2"',
            '',
            '--a2',
            'Content-Type: text/html',
            '',
            '<p>Nested A.</p>',
            '--a2',
            'Content-Type: text/html',
            '',
            '<p>Nested B.</p>',
            '--a2--',
          ),
        ),
        spy.htmlToText,
      );
      expect(spy.calls).toEqual([]);
      expect(message.bodyText).toBe('P');
      expect(message.warnings).not.toContain('html-converted-body');
      expect(message.warnings).toEqual([]);
    });

    it('an alternative whose only HTML is whitespace-only: no body, converter not called', async () => {
      const spy = spyConverter();
      const message = await parseWith(alternativeOnly('Content-Type: text/html\r\n\r\n   '), spy.htmlToText);
      expect(spy.calls).toEqual([]);
      expect(message.bodyText).toBe('');
      expect(message.warnings).toContain('no-body');
      expect(message.warnings).not.toContain('html-converted-body');
    });

    it('two plain versions are both kept: duplication is preferred to loss', async () => {
      const message = await parseOk(
        alternativeOnly('Content-Type: text/plain\r\n\r\nSame text.', 'Content-Type: text/plain\r\n\r\nSame text.'),
      );
      expect(message.bodyText).toBe('Same text.\nSame text.');
    });

    it('a forwarded message present in two versions is expanded twice (duplication, not loss)', async () => {
      const forward = crlf('Content-Type: message/rfc822', '', 'From: fwd@example.test', 'Subject: fwd', '', 'Body of fwd.');
      const spy = spyConverter();
      const message = await parseWith(
        alternativeOnly(
          innerMixed('Content-Type: text/plain\r\n\r\nPlain version.', forward),
          crlf(
            'Content-Type: multipart/mixed; boundary="in2"',
            '',
            '--in2',
            'Content-Type: text/html',
            '',
            '<p>HTML version.</p>',
            '--in2',
            forward,
            '--in2--',
          ),
        ),
        spy.htmlToText,
      );
      const block = ['---------- Forwarded message ----------', 'From: fwd@example.test', 'Subject: fwd', '', 'Body of fwd.'];
      expect(spy.calls).toEqual([]);
      // Each inner body keeps its final line break; the blank-line join absorbs the first one.
      expect(message.bodyText).toBe(['Plain version.', '', ...block, '', ...block, ''].join('\n'));
      expect(message.attachments).toEqual([]);
      expect(message.warnings).toEqual([]);
    });
  });

  it('an inline forwarded message with text/plain + text/html in mixed converts its HTML too', async () => {
    const spy = spyConverter();
    const inner = crlf(
      'From: carol@example.test',
      'Subject: Inner',
      'Content-Type: multipart/mixed; boundary="in"',
      '',
      '--in',
      'Content-Type: text/plain',
      '',
      'Inner plain.',
      '--in',
      'Content-Type: text/html',
      '',
      STYLED_HTML,
      '--in--',
    );
    const message = await parseWith(
      mixed('Content-Type: text/plain\r\n\r\nOuter.', crlf('Content-Type: message/rfc822', '', inner)),
      spy.htmlToText,
    );
    expect(spy.calls).toEqual([STYLED_HTML]);
    expect(message.bodyText).toBe(
      [
        'Outer.',
        '',
        '---------- Forwarded message ----------',
        'From: carol@example.test',
        'Subject: Inner',
        '',
        'Inner plain.',
        '[html 1]',
      ].join('\n'),
    );
    expect(message.bodyText).not.toContain('color');
    expect(message.bodyText).not.toContain('tracker');
    expect(message.warnings).toEqual(['html-converted-body']);
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

  // A converter failure is not a damaged file: the message is still read,
  // the failed HTML part adds NO text (nothing is invented in its place), and
  // 'html-body-unreadable' tells the preview content is missing (README.md, rule R6).
  const throwingParser = (thrown: unknown) =>
    createEmlParser({
      htmlToText: () => {
        // Typed unknown: a converter may throw anything, not only an Error.
        throw thrown;
      },
    });
  const HTML_ONLY = bytes(HEADERS, '\r\nContent-Type: text/html\r\n\r\n<p>x</p>\r\n');

  /** Parses `data` and returns the message, failing the test if the file failed. */
  async function readWith(p: EmailParser, data: Uint8Array): Promise<NormalizedMessage> {
    const result = await p.parse({ name: 'h.eml', bytes: data });
    if (!result.ok) throw new Error(`unexpected failure: ${result.detail}`);
    return result.message;
  }

  it('a failing htmlToText leaves the HTML part out with html-body-unreadable; the rest of the message is read', async () => {
    const message = await readWith(throwingParser(new Error('converter failed')), HTML_ONLY);
    expect(message.bodyText).toBe('');
    // No 'no-body': there was a body, it could not be shown.
    expect(message.warnings).toEqual(['html-body-unreadable']);
    expect(message.subject).toBe('Test message');
    expect(message.from).toEqual([{ name: 'Alice Example', address: 'alice@example.test' }]);
    expect(message.source).toEqual({ fileName: 'h.eml', sha256: await sha256Hex(HTML_ONLY), kind: 'eml' });
  });

  it('only the failed HTML part is missing: other text parts and attachments stay', async () => {
    const data = bytes(
      HEADERS,
      '\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n',
      '--b\r\nContent-Type: text/plain\r\n\r\nIntro\r\n',
      '--b\r\nContent-Type: text/html\r\n\r\n<p>lost</p>\r\n',
      '--b\r\nContent-Type: text/plain\r\n\r\nOutro\r\n',
      '--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="plan.pdf"\r\n',
      'Content-Transfer-Encoding: base64\r\n\r\nAAEC\r\n--b--\r\n',
    );
    const message = await readWith(throwingParser(new RangeError('Maximum call stack size exceeded')), data);
    expect(message.bodyText).toBe('Intro\nOutro');
    expect(message.attachments.map((a) => a.fileName)).toEqual(['plan.pdf']);
    expect(message.warnings).toEqual(['html-body-unreadable']);
  });

  it('a converter failing on one HTML part only: the other part is converted, and both warnings are set', async () => {
    let calls = 0;
    const flaky = createEmlParser({
      htmlToText: (html) => {
        if (++calls === 2) throw new Error('second part failed');
        return { text: `[stub] ${html.length}`, truncated: false };
      },
    });
    const data = bytes(
      HEADERS,
      '\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n',
      '--b\r\nContent-Type: text/html\r\n\r\n<p>one</p>\r\n',
      '--b\r\nContent-Type: text/html\r\n\r\n<p>two</p>\r\n--b--\r\n',
    );
    const message = await readWith(flaky, data);
    expect(message.bodyText).toMatch(/^\[stub\] \d+$/);
    expect(message.warnings).toEqual(['html-converted-body', 'html-body-unreadable']);
  });

  it.each([
    ['a TypeError', new TypeError('x.trim is not a function')],
    ['a RangeError (e.g. a stack overflow)', new RangeError('Maximum call stack size exceeded')],
    ['a thrown non-Error value', 'plain string'],
    ['an Error with an empty message', new Error('')],
  ])('%s thrown by htmlToText gives html-body-unreadable, never a failed file', async (_label, thrown: unknown) => {
    const message = await readWith(throwingParser(thrown), HTML_ONLY);
    expect(message.warnings).toEqual(['html-body-unreadable']);
    expect(message.bodyText).toBe('');
  });

  it.each([
    ['undefined', undefined],
    ['a bare string', 'text'],
    ['no truncated flag', { text: 'text' }],
    ['a non-string text', { text: 42, truncated: false }],
  ])('an htmlToText that returns %s (not a { text, truncated } result) gives html-body-unreadable', async (_label, value: unknown) => {
    const message = await readWith(createEmlParser({ htmlToText: () => value as HtmlToTextResult }), HTML_ONLY);
    expect(message.warnings).toEqual(['html-body-unreadable']);
    // Nothing the broken converter returned ends up in the text.
    expect(message.bodyText).toBe('');
  });

  it('a failing htmlToText inside an inline forwarded message: the block stays, the warning reaches the outer message', async () => {
    const inner = crlf('From: carol@example.test', 'Subject: inner', 'Content-Type: text/html', '', '<p>inner</p>');
    const data = bytes(
      HEADERS,
      '\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nouter\r\n',
      `--b\r\nContent-Type: message/rfc822\r\n\r\n${inner}\r\n--b--\r\n`,
    );
    const message = await readWith(throwingParser(new TypeError('inner failure')), data);
    expect(message.bodyText).toContain('outer');
    expect(message.bodyText).toContain('Subject: inner');
    expect(message.bodyText).not.toContain('<p>');
    expect(message.warnings).toEqual(['html-body-unreadable']);
  });
});
