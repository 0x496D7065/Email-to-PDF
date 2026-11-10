// Unit tests for the emails attached inside an .eml file (ParseResult.attached,
// task 8.13b-1): each one becomes an email of its own, read from its own
// headers, while the file's own email stays exactly as before. Every message
// is built in memory from synthetic text (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { createEmlParser } from './eml';
import { FORWARDED_SEPARATOR } from './forwarded-block';
import { sha256Hex } from './hash';
import type { HtmlToTextResult } from './html-to-text';
import type { AttachedMessage, NormalizedMessage, ParseResult } from './types';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const crlf = (...lines: string[]): string => lines.join('\r\n');

const OUTER_HEADERS = crlf(
  'From: Alice Example <alice@example.test>',
  'To: Bob Sample <bob@example.test>',
  'Subject: Outer',
  'Date: Tue, 3 Jun 2025 14:05:09 +0200',
  'Message-ID: <outer@example.test>',
  'MIME-Version: 1.0',
);

/** A multipart/mixed body holding `parts`, with boundary `b`. */
const mixed = (b: string, ...parts: string[]): string =>
  crlf(`Content-Type: multipart/mixed; boundary="${b}"`, '', ...parts.flatMap((p) => [`--${b}`, p]), `--${b}--`, '');

/** A whole file: the outer headers, then a multipart/mixed body. */
const file = (...parts: string[]): Uint8Array => encode(crlf(OUTER_HEADERS, mixed('outer', ...parts)));

const plain = (text: string): string => crlf('Content-Type: text/plain; charset=utf-8', '', text);

/** A message/rfc822 part: inline (no Content-Disposition) unless `disposition` is given. */
const rfc822 = (message: string, disposition?: string): string =>
  crlf('Content-Type: message/rfc822', ...(disposition === undefined ? [] : [`Content-Disposition: ${disposition}`]), '', message);

const AS_FILE = 'attachment; filename="attached.eml"';

/** A simple inner email. */
const inner = (name: string, body: string, ...extra: string[]): string =>
  crlf(
    `From: ${name}@example.test`,
    'Date: Mon, 2 Jun 2025 10:00:00 +0100',
    `Subject: ${name}`,
    `Message-ID: <${name}@example.test>`,
    ...extra,
    '',
    body,
  );

const stub = (html: string): HtmlToTextResult => ({ text: `[html ${String(html.length)}]`, truncated: false });
const parser = createEmlParser({ htmlToText: stub });

type OkResult = Extract<ParseResult, { ok: true }>;

async function parseOk(data: Uint8Array, name = 'attached-test.eml'): Promise<OkResult> {
  const result = await parser.parse({ name, bytes: data });
  if (!result.ok) throw new Error(`expected ok, got ${result.error}: ${result.detail}`);
  return result;
}

function attachedAt(result: OkResult, index: number): AttachedMessage {
  const entry = result.attached?.[index];
  if (entry === undefined) throw new Error(`no attached email ${String(index)}`);
  return entry;
}

/** The body of a holder: -1 = the file's own email. */
function holderBody(result: OkResult, holder: number): string {
  return holder === -1 ? result.message.bodyText : attachedAt(result, holder).message.bodyText;
}

/** Every place of every attached email: the slice starts with the separator and ends with its own body. */
function expectPlacesPrintTheEmail(result: OkResult): void {
  for (const entry of result.attached ?? []) {
    for (const place of entry.places) {
      const slice = holderBody(result, place.holder).slice(place.start, place.end);
      expect(slice.startsWith(`${FORWARDED_SEPARATOR}\n`)).toBe(true);
      expect(slice.endsWith(entry.message.bodyText)).toBe(true);
    }
  }
}

describe('attached emails: inline (no Content-Disposition)', () => {
  const INNER = crlf(
    'From: =?utf-8?Q?Caf=C3=A9_Owner?= <carol@example.test>',
    'Sender: Desk <desk@example.test>',
    'Date: Mon, 2 Jun 2025 23:30:00 +0530',
    'Subject: =?utf-8?Q?R=C3=A9union?=',
    'To: Dave Test <dave@example.test>,',
    ' erin@example.test',
    'Cc: frank@example.test',
    'Bcc: grace@example.test',
    'Message-ID: <inner@example.test>',
    'In-Reply-To: <earlier@example.test>',
    'References: <first@example.test> <earlier@example.test>',
    '',
    'Inner body text.',
  );

  it('the parent body is exactly as before, and the inner email becomes an AttachedMessage from its own headers', async () => {
    const data = file(plain('See below.'), rfc822(INNER));
    const result = await parseOk(data);
    const header = [
      FORWARDED_SEPARATOR,
      'From: Café Owner <carol@example.test>',
      'Sender: Desk <desk@example.test>',
      'Date: Mon, 2 Jun 2025 23:30:00 +0530',
      'Subject: Réunion',
      'To: Dave Test <dave@example.test>, erin@example.test',
      'Cc: frank@example.test',
      'Bcc: grace@example.test',
    ].join('\n');
    expect(result.message.bodyText).toBe(`See below.\n\n${header}\n\nInner body text.\n`);
    expect(result.message.attachments).toEqual([]);
    expect(result.message.warnings).toEqual([]);
    expect(result.message.source).toEqual({ fileName: 'attached-test.eml', sha256: await sha256Hex(data), kind: 'eml' });

    expect(result.attached).toHaveLength(1);
    const entry = attachedAt(result, 0);
    expect(entry.parent).toBe(-1);
    expect(entry.path).toEqual([1]);
    const start = 'See below.\n\n'.length;
    expect(entry.places).toEqual([{ holder: -1, start, end: result.message.bodyText.length }]);
    // The slice is the block exactly as printed: separator, header lines, blank line, body.
    expect(result.message.bodyText.slice(start)).toBe(`${header}\n\n${entry.message.bodyText}`);

    const expected: NormalizedMessage = {
      messageId: 'inner@example.test',
      inReplyTo: 'earlier@example.test',
      references: ['first@example.test', 'earlier@example.test'],
      // The raw Date text and the sender's own zone are kept.
      date: {
        utcMs: Date.parse('2025-06-02T18:00:00Z'),
        original: 'Mon, 2 Jun 2025 23:30:00 +0530',
        offsetMinutes: 330,
        zoneKnown: true,
      },
      from: [{ name: 'Café Owner', address: 'carol@example.test' }],
      sender: { name: 'Desk', address: 'desk@example.test' },
      to: [
        { name: 'Dave Test', address: 'dave@example.test' },
        { name: '', address: 'erin@example.test' },
      ],
      cc: [{ name: '', address: 'frank@example.test' }],
      bcc: [{ name: '', address: 'grace@example.test' }],
      subject: 'Réunion',
      bodyText: 'Inner body text.\n',
      attachments: [],
      // fileName and sha256 stay the dropped file's.
      source: { fileName: 'attached-test.eml', sha256: await sha256Hex(data), kind: 'eml', attachedPath: [1] },
      warnings: [],
    };
    expect(entry.message).toEqual(expected);
  });

  it('a file without attached email has no `attached` key', async () => {
    const result = await parseOk(file(plain('Only text.')));
    expect('attached' in result).toBe(false);
  });

  it('an inner email without Date gets missing-date on its own message only', async () => {
    const result = await parseOk(file(plain('See below.'), rfc822(crlf('From: carol@example.test', '', 'No date here.'))));
    expect(result.message.warnings).toEqual([]);
    const { message } = attachedAt(result, 0);
    expect(message.date).toEqual({ utcMs: null, original: '', offsetMinutes: null, zoneKnown: false });
    expect(message.warnings).toEqual(['missing-date', 'missing-message-id']);
  });

  it('a header-only inner email: the block has no body; the place ends with the header lines', async () => {
    const result = await parseOk(file(plain('See below.'), rfc822(crlf('From: carol@example.test', 'Subject: Empty', '', ''))));
    const entry = attachedAt(result, 0);
    expect(entry.message.bodyText).toBe('');
    expect(entry.message.warnings).toContain('no-body');
    const [place] = entry.places;
    expect(result.message.bodyText.slice(place?.start, place?.end)).toBe(
      `${FORWARDED_SEPARATOR}\nFrom: carol@example.test\nSubject: Empty`,
    );
  });

  it('its attachments are listed flat in the parent, marked with its index, and unmarked in its own message', async () => {
    const pdf = crlf(
      'Content-Type: application/pdf; name="a.pdf"',
      'Content-Disposition: attachment; filename="a.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0xLjQK',
    );
    const result = await parseOk(file(plain('Own text.'), rfc822(crlf('From: c@example.test', mixed('in', plain('Inner.'), pdf)))));
    expect(result.message.attachments).toEqual([{ fileName: 'a.pdf', size: 9, mimeType: 'application/pdf', attachedIndex: 0 }]);
    expect(attachedAt(result, 0).message.attachments).toEqual([{ fileName: 'a.pdf', size: 9, mimeType: 'application/pdf' }]);
  });

  it('a multipart/alternative with the same forward in two versions gives two blocks and two entries', async () => {
    const alternative = crlf(
      'Content-Type: multipart/alternative; boundary="alt"',
      '',
      '--alt',
      mixed('v1', plain('Version one.'), rfc822(inner('same', 'Same body.'))),
      '--alt',
      mixed('v2', plain('Version two.'), rfc822(inner('same', 'Same body.'))),
      '--alt--',
    );
    const result = await parseOk(file(alternative));
    expect(result.message.bodyText.split(FORWARDED_SEPARATOR)).toHaveLength(3);
    expect(result.attached).toHaveLength(2);
    const [first, second] = [attachedAt(result, 0), attachedAt(result, 1)];
    expect(first.path).toEqual([1]);
    expect(second.path).toEqual([2]);
    expect(first.message).toEqual({ ...second.message, source: first.message.source });
    const slice = (e: AttachedMessage): string => result.message.bodyText.slice(e.places[0]?.start, e.places[0]?.end);
    expect(slice(first)).toBe(slice(second));
    expect(second.places[0]?.start).toBeGreaterThan(first.places[0]?.end ?? Infinity);
    expectPlacesPrintTheEmail(result);
  });

  it('nested inline emails have a place in every ancestor, nearest first', async () => {
    const level3 = inner('level3', 'Body 3.');
    const level2 = crlf('From: level2@example.test', 'Subject: L2', mixed('l2', plain('Body 2.'), rfc822(level3)));
    const level1 = crlf('From: level1@example.test', 'Subject: L1', mixed('l1', plain('Body 1.'), rfc822(level2)));
    const result = await parseOk(file(plain('Top.'), rfc822(level1)));
    expect(result.attached?.map((e) => [e.parent, e.path])).toEqual([
      [-1, [1]],
      [0, [1, 1]],
      [1, [1, 1, 1]],
    ]);
    expect(attachedAt(result, 2).places.map((p) => p.holder)).toEqual([1, 0, -1]);
    expect(attachedAt(result, 1).places.map((p) => p.holder)).toEqual([0, -1]);
    expectPlacesPrintTheEmail(result);
    // The same text in every holder.
    const texts = attachedAt(result, 2).places.map((p) => holderBody(result, p.holder).slice(p.start, p.end));
    expect(new Set(texts).size).toBe(1);
  });
});

describe('attached emails: sent as an attachment (Content-Disposition: attachment)', () => {
  /**
   * The same file with every attached email turned into an opaque file (a
   * type of the same length, so every size stays the same): what the parent
   * looked like before attached emails were read.
   */
  const OPAQUE = 'image/x-opaque';
  const asOpaque = (data: Uint8Array): Uint8Array =>
    encode(new TextDecoder().decode(data).replaceAll('Content-Type: message/rfc822', `Content-Type: ${OPAQUE}`));

  async function expectParentUnchanged(data: Uint8Array): Promise<OkResult> {
    const result = await parseOk(data);
    const control = await parseOk(asOpaque(data));
    const relabel = (m: NormalizedMessage) =>
      m.attachments.map((a) => ({ ...a, mimeType: a.mimeType === 'message/rfc822' ? OPAQUE : a.mimeType }));
    expect(result.message.bodyText).toBe(control.message.bodyText);
    expect(relabel(result.message)).toEqual(control.message.attachments);
    expect(result.message.warnings).toEqual(control.message.warnings);
    return result;
  }

  it('the parent only lists it (no text, no warning); it becomes an AttachedMessage with no place', async () => {
    const message = inner('carol', 'Attached body.');
    const result = await expectParentUnchanged(file(plain('See attached.'), rfc822(message, AS_FILE)));
    expect(result.message.bodyText).toBe('See attached.');
    expect(result.message.attachments).toEqual([{ fileName: 'attached.eml', size: message.length, mimeType: 'message/rfc822' }]);
    expect(result.message.warnings).toEqual([]);
    expect(result.attached).toHaveLength(1);
    const entry = attachedAt(result, 0);
    expect(entry).toMatchObject({ parent: -1, places: [], path: [1] });
    expect(entry.message.messageId).toBe('carol@example.test');
    expect(entry.message.date.original).toBe('Mon, 2 Jun 2025 10:00:00 +0100');
    // The line break before the closing boundary belongs to the part, as for any email.
    expect(entry.message.bodyText).toBe('Attached body.\n');
    expect(entry.message.source.attachedPath).toEqual([1]);
  });

  it('its HTML goes through the injected converter, after the HTML of the inline parts', async () => {
    const calls: string[] = [];
    const htmlToText = (html: string): HtmlToTextResult => ({ text: `[html ${String(calls.push(html))}]`, truncated: false });
    const htmlPart = (html: string): string => crlf('Content-Type: text/html', '', html);
    const data = file(
      rfc822(crlf('From: a@example.test', htmlPart('<p>attached</p>')), AS_FILE),
      rfc822(crlf('From: b@example.test', htmlPart('<p>inline</p>'))),
    );
    const result = await createEmlParser({ htmlToText }).parse({ name: 'h.eml', bytes: data });
    if (!result.ok) throw new Error(result.detail);
    expect(calls).toEqual(['<p>inline</p>\n', '<p>attached</p>\n']);
    expect(result.message.bodyText).toContain('[html 1]');
    expect(result.message.bodyText).not.toContain('[html 2]');
    // In file order: the attached one is the first message/rfc822 part.
    expect(result.attached?.map((e) => [e.path, e.message.bodyText, [...e.message.warnings]])).toEqual([
      [[1], '[html 2]', ['missing-date', 'html-converted-body', 'missing-message-id']],
      [[2], '[html 1]', ['missing-date', 'html-converted-body', 'missing-message-id']],
    ]);
  });

  it('unreadable inner bytes: the parent is unchanged and there is no AttachedMessage', async () => {
    let deep = 'Content-Type: text/plain\r\n\r\ndeep\r\n';
    for (let i = 0; i < 70; i++) deep = `Content-Type: multipart/mixed; boundary="n${i}"\r\n\r\n--n${i}\r\n${deep}--n${i}--\r\n`;
    const tooDeep = `From: carol@example.test\r\nSubject: Too deep\r\n${deep}`;
    const result = await expectParentUnchanged(
      file(plain('x'), rfc822('\0\x01garbage no headers', AS_FILE), rfc822(tooDeep, AS_FILE)),
    );
    expect(result.message.attachments).toHaveLength(2);
    expect(result.message.warnings).toEqual([]);
    expect('attached' in result).toBe(false);
  });

  it('nested 3 deep, mixing both kinds: places only in the bodies that print the block', async () => {
    // top --inline--> A --attachment--> B --inline--> C
    const c = inner('cc', 'C body.');
    const b = crlf('From: bb@example.test', 'Subject: B', mixed('b', plain('B body.'), rfc822(c)));
    const a = crlf('From: aa@example.test', 'Subject: A', mixed('a', plain('A body.'), rfc822(b, AS_FILE)));
    const result = await parseOk(file(plain('Top.'), rfc822(a)));
    expect(result.attached?.map((e) => [e.message.subject, e.parent, e.path])).toEqual([
      ['A', -1, [1]],
      ['B', 0, [1, 1]],
      ['cc', 1, [1, 1, 1]],
    ]);
    expect(attachedAt(result, 0).places.map((p) => p.holder)).toEqual([-1]);
    expect(attachedAt(result, 1).places).toEqual([]);
    expect(attachedAt(result, 2).places.map((p) => p.holder)).toEqual([1]);
    expectPlacesPrintTheEmail(result);
    // C is printed in B's body only, never in A's or the top's.
    expect(result.message.bodyText).not.toContain('C body.');
    expect(attachedAt(result, 0).message.bodyText).not.toContain('C body.');
    // B is listed by name in A, and so in the top's flat list, marked as A's.
    expect(result.message.attachments).toEqual([{ fileName: 'attached.eml', size: b.length, mimeType: 'message/rfc822', attachedIndex: 0 }]);
    expect(attachedAt(result, 0).message.attachments).toEqual([{ fileName: 'attached.eml', size: b.length, mimeType: 'message/rfc822' }]);
    // B's own list holds nothing: C was expanded into its body.
    expect(attachedAt(result, 1).message.attachments).toEqual([]);
  });

  it('the other way round: top --attachment--> A --inline--> B --attachment--> C', async () => {
    const c = inner('cc', 'C body.');
    const b = crlf('From: bb@example.test', 'Subject: B', mixed('b', plain('B body.'), rfc822(c, AS_FILE)));
    const a = crlf('From: aa@example.test', 'Subject: A', mixed('a', plain('A body.'), rfc822(b)));
    const result = await expectParentUnchanged(file(plain('Top.'), rfc822(a, AS_FILE)));
    expect(result.attached?.map((e) => [e.message.subject, e.parent, e.places.map((p) => p.holder)])).toEqual([
      ['A', -1, []],
      ['B', 0, [0]],
      ['cc', 1, []],
    ]);
    expectPlacesPrintTheEmail(result);
  });

  it('a delivery report keeps its attached email listed only (not read)', async () => {
    const result = await parseOk(
      file(
        plain('Delivery failed.'),
        crlf('Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; mx.example.test'),
        rfc822(inner('original', 'Original.'), AS_FILE),
        rfc822(inner('original2', 'Original 2.')),
      ),
    );
    expect('attached' in result).toBe(false);
  });
});

describe('attached emails: limits (shared by both kinds)', () => {
  /** A chain: level 1 holds level 2 ... `disposition(level)` says how level `level` is attached. */
  function chain(level: number, levels: number, disposition: (level: number) => string | undefined): string {
    const head = [`From: level${level}@example.test`, `Subject: Level ${level}`];
    if (level === levels) return crlf(...head, '', `Body ${level}.`);
    return crlf(...head, mixed(`c${level}`, plain(`Body ${level}.`), rfc822(chain(level + 1, levels, disposition), disposition(level + 1))));
  }

  it.each([
    ['all sent as attachments', () => AS_FILE],
    ['alternating', (level: number) => (level % 2 === 0 ? AS_FILE : undefined)],
  ] as const)('at most 5 levels are read (%s)', async (_label, disposition) => {
    const result = await parseOk(file(plain('Top.'), rfc822(chain(1, 7, disposition), disposition(1))));
    expect(result.attached?.map((e) => e.message.subject)).toEqual(['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5']);
    expect(attachedAt(result, 4).path).toEqual([1, 1, 1, 1, 1]);
  });

  it('a file with 201 emails sent as attachments: 200 are read, all 201 listed, no warning', async () => {
    const parts = Array.from({ length: 201 }, (_, i) => rfc822(inner(`n${String(i + 1)}`, `Body ${String(i + 1)}.`), AS_FILE));
    const result = await parseOk(file(plain('Top.'), ...parts));
    expect(result.message.bodyText).toBe('Top.');
    expect(result.message.attachments).toHaveLength(201);
    expect(result.message.warnings).toEqual([]);
    expect(result.attached).toHaveLength(200);
    expect(attachedAt(result, 199).path).toEqual([200]);
  });

  it('inline emails are read first: 1 sent as attachment + 200 inline keeps all 200 blocks in the body', async () => {
    const inlineParts = Array.from({ length: 200 }, (_, i) => rfc822(inner(`n${String(i + 1)}`, `Body ${String(i + 1)}.`)));
    const result = await parseOk(file(plain('Top.'), rfc822(inner('first', 'First.'), AS_FILE), ...inlineParts));
    expect(result.message.bodyText.split(FORWARDED_SEPARATOR)).toHaveLength(201);
    expect(result.message.bodyText).toContain('Body 200.');
    expect(result.message.warnings).toEqual([]);
    // The budget is used up by the inline ones: the one sent as an attachment is not read.
    expect(result.attached).toHaveLength(200);
    expect(result.attached?.some((e) => e.message.subject === 'first')).toBe(false);
    expect(attachedAt(result, 0).path).toEqual([2]);
  });

  it('emails sent as attachments use up the budget for later inline ones inside them', async () => {
    // 199 inline at the top, then one sent as an attachment holding 2 inline:
    // the attached one is read (200th), its inline ones are over the budget.
    const inlineParts = Array.from({ length: 199 }, (_, i) => rfc822(inner(`n${String(i + 1)}`, 'x')));
    const holder = crlf('From: h@example.test', 'Subject: Holder', mixed('h', plain('Holder.'), rfc822(inner('i1', 'y')), rfc822(inner('i2', 'z'))));
    const result = await parseOk(file(plain('Top.'), ...inlineParts, rfc822(holder, AS_FILE)));
    expect(result.attached).toHaveLength(200);
    const last = attachedAt(result, 199);
    expect(last.message.subject).toBe('Holder');
    expect(last.message.warnings).toContain('forwarded-message-not-expanded');
    expect(last.message.attachments).toHaveLength(2);
    expect(result.message.warnings).toEqual([]);
  });
});
