// Unit tests for the Outlook items attached inside a .msg file
// (ParseResult.attached, task 8.13b-2): each one becomes an email of its own,
// read from its own properties, while the file's own email stays exactly as
// before. Every .msg is built in memory from synthetic specs with
// tests/fixtures/msg/builder.ts (README.md, rule R7); nothing is read from
// disk and no .msg file is ever written.

import type { FieldsData } from '@kenjiuno/msgreader';
import { describe, expect, it } from 'vitest';
import { buildMsg, type MsgAttachedItemSpec, type MsgSpec } from '../../tests/fixtures/msg/builder';
import { MAX_EXPANDED_FORWARDS, MAX_FORWARD_DEPTH } from './attached-limits';
import { sha256Hex } from './hash';
import type { HtmlToTextResult } from './html-to-text';
import { createMsgParser, resultFromFields } from './msg';
import type { AttachedMessage, ParseResult } from './types';
import { isFromWorker } from './worker-protocol';

const stub = (html: string): HtmlToTextResult => ({ text: `[html ${String(html.length)}]`, truncated: false });
const parser = createMsgParser({ htmlToText: stub });

const ALICE = { name: 'Alice Example', smtp: 'alice@example.test' };
const BOB = { name: 'Bob Sample', smtp: 'bob@example.test' };
const CAROL = { name: 'Carol Test', smtp: 'carol@example.test' };

const OUTER: MsgSpec = {
  id: 'outer',
  description: 'outer message',
  strings: 'unicode',
  subject: 'Outer',
  sender: ALICE,
  recipients: [{ ...BOB, type: 'to' }],
  bodyText: 'Outer body.',
  submitTime: '2025-06-03T12:05:09Z',
  messageId: '<outer@example.test>',
};

/** A simple inner message named `name`. */
const inner = (name: string, extra: Partial<MsgSpec> = {}): MsgSpec => ({
  ...OUTER,
  id: name,
  subject: name,
  sender: CAROL,
  bodyText: `${name} body.`,
  submitTime: '2025-06-01T08:00:00Z',
  messageId: `<${name}@example.test>`,
  ...extra,
});

const item = (message: MsgSpec): MsgAttachedItemSpec => ({ displayName: message.subject, message });

/** A chain of items L1 > L2 > ... > L`levels`, each attached to the one before. */
const chain = (level: number, levels: number): MsgSpec =>
  inner(`L${String(level)}`, level === levels ? {} : { attachedItems: [item(chain(level + 1, levels))] });

type OkResult = Extract<ParseResult, { ok: true }>;

async function parseOk(spec: MsgSpec, name = 'attached-test.msg'): Promise<OkResult> {
  const result = await parser.parse({ name, bytes: buildMsg(spec) });
  if (!result.ok) throw new Error(`expected ok, got ${result.error}: ${result.detail}`);
  expect(isFromWorker({ type: 'result', result })).toBe(true);
  return result;
}

function entry(result: OkResult, index: number): AttachedMessage {
  const value = result.attached?.[index];
  if (value === undefined) throw new Error(`no attached email at ${String(index)}`);
  return value;
}

const shape = (result: OkResult): [string, number, readonly number[]][] =>
  (result.attached ?? []).map((e) => [e.message.subject, e.parent, e.path]);

describe('createMsgParser: attached Outlook items as emails of their own', () => {
  it('reads one attached item from its own properties, with the dropped file as its source', async () => {
    const spec: MsgSpec = { ...OUTER, attachedItems: [item(inner('A', { inReplyTo: '<outer@example.test>' }))] };
    const result = await parseOk(spec, 'outer.msg');
    expect(result.attached).toHaveLength(1);
    const a = entry(result, 0);
    expect(a.parent).toBe(-1);
    expect(a.places).toEqual([]);
    expect(a.path).toEqual([1]);
    expect(a.message).toEqual({
      messageId: 'A@example.test',
      inReplyTo: 'outer@example.test',
      references: [],
      date: { utcMs: Date.UTC(2025, 5, 1, 8, 0, 0), original: '2025-06-01T08:00:00.000Z', offsetMinutes: null, zoneKnown: true },
      from: [{ name: 'Carol Test', address: 'carol@example.test' }],
      to: [{ name: 'Bob Sample', address: 'bob@example.test' }],
      cc: [],
      bcc: [],
      subject: 'A',
      bodyText: 'A body.',
      attachments: [],
      source: { fileName: 'outer.msg', sha256: await sha256Hex(buildMsg(spec)), kind: 'msg', attachedPath: [1] },
      warnings: [],
    });
  });

  it('leaves the file\'s own email as it was: listed item, no text of the item; no warning once the item is read (8.13b-3)', async () => {
    const result = await parseOk({ ...OUTER, attachedItems: [item(inner('A', { bodyText: 'INNER-BODY-MARKER' }))] });
    expect(result.message.bodyText).toBe('Outer body.');
    expect(result.message.attachments).toEqual([{ fileName: 'A.msg', size: null, mimeType: 'application/vnd.ms-outlook' }]);
    expect(result.message.warnings).toEqual([]);
    expect(entry(result, 0).name).toBe('A.msg');
    expect(result.message.source).toEqual({ fileName: 'attached-test.msg', sha256: expect.any(String) as unknown, kind: 'msg' });
    expect(JSON.stringify(result.message)).not.toContain('INNER-BODY-MARKER');
    expect(entry(result, 0).message.bodyText).toBe('INNER-BODY-MARKER');
  });

  it('has no attached key when the file holds no attached item', async () => {
    const result = await parseOk({ ...OUTER, attachments: [{ fileName: 'a.txt', content: 'x' }] });
    expect('attached' in result).toBe(false);
  });

  it('reads nested items depth first, numbering only the Outlook items of each holder', async () => {
    const result = await parseOk({
      ...OUTER,
      attachments: [{ fileName: 'plan.txt', content: 'plan' }],
      attachedItems: [
        item(inner('A', { attachments: [{ fileName: 'a.txt', content: 'a' }], attachedItems: [item(inner('A1')), item(inner('A2'))] })),
        item(inner('B', { attachedItems: [item(inner('B1', { attachedItems: [item(inner('B11'))] }))] })),
      ],
    });
    expect(shape(result)).toEqual([
      ['A', -1, [1]],
      ['A1', 0, [1, 1]],
      ['A2', 0, [1, 2]],
      ['B', -1, [2]],
      ['B1', 3, [2, 1]],
      ['B11', 4, [2, 1, 1]],
    ]);
    for (const e of result.attached ?? []) {
      expect(e.places).toEqual([]);
      expect(e.message.source.attachedPath).toEqual(e.path);
    }
    // A holder lists its own items (and only them), like the file's own email.
    expect(entry(result, 0).message.attachments.map((a) => a.fileName)).toEqual(['a.txt', 'A1.msg', 'A2.msg']);
    // Every item of A was read as an email of its own: no "not expanded" warning (task 8.13b-3).
    expect(entry(result, 0).message.warnings).toEqual([]);
    expect(entry(result, 1).message.warnings).toEqual([]);
    expect(result.message.warnings).toEqual([]);
    expect((result.attached ?? []).map((e) => e.name)).toEqual(['A.msg', 'A1.msg', 'A2.msg', 'B.msg', 'B1.msg', 'B11.msg']);
  });

  it(`reads ${String(MAX_FORWARD_DEPTH)} levels of items, no deeper; the deepest one stays listed`, async () => {
    const result = await parseOk({ ...OUTER, attachedItems: [item(chain(1, MAX_FORWARD_DEPTH + 2))] });
    expect(shape(result)).toEqual([
      ['L1', -1, [1]],
      ['L2', 0, [1, 1]],
      ['L3', 1, [1, 1, 1]],
      ['L4', 2, [1, 1, 1, 1]],
      ['L5', 3, [1, 1, 1, 1, 1]],
    ]);
    const last = entry(result, MAX_FORWARD_DEPTH - 1);
    expect(last.message.attachments).toEqual([{ fileName: 'L6.msg', size: null, mimeType: 'application/vnd.ms-outlook' }]);
    expect(last.message.warnings).toEqual(['forwarded-message-not-expanded']);
  });

  it(`reads at most ${String(MAX_EXPANDED_FORWARDS)} items per file, level by level`, async () => {
    // 198 items at the top, the first holding 5: the top level is read
    // first (198), then the first 2 of the 5 inside.
    const top = Array.from({ length: 198 }, (_, i) =>
      item(inner(`N${String(i + 1)}`, i === 0 ? { attachedItems: Array.from({ length: 5 }, (_, j) => item(inner(`C${String(j + 1)}`))) } : {})),
    );
    const result = await parseOk({ ...OUTER, attachedItems: top });
    expect(result.attached).toHaveLength(MAX_EXPANDED_FORWARDS);
    expect(shape(result).slice(0, 4)).toEqual([
      ['N1', -1, [1]],
      ['C1', 0, [1, 1]],
      ['C2', 0, [1, 2]],
      ['N2', -1, [2]],
    ]);
    expect(shape(result).at(-1)).toEqual(['N198', -1, [198]]);
    // Every item is still listed where it was.
    expect(result.message.attachments).toHaveLength(198);
    expect(entry(result, 0).message.attachments).toHaveLength(5);
  });

  it('keeps every other attachment type listed only (name, size, type), never read', async () => {
    const result = await parseOk({
      ...OUTER,
      attachments: [{ fileName: 'outer.pdf', mimeType: 'application/pdf', content: 'OUTER-CONTENT-MARKER' }],
      attachedItems: [item(inner('A', { attachments: [{ fileName: 'invoice.txt', mimeType: 'text/plain', content: 'INNER-CONTENT-MARKER' }] }))],
    });
    expect(result.message.attachments).toEqual([
      { fileName: 'outer.pdf', size: 20, mimeType: 'application/pdf' },
      { fileName: 'A.msg', size: null, mimeType: 'application/vnd.ms-outlook' },
    ]);
    expect(entry(result, 0).message.attachments).toEqual([{ fileName: 'invoice.txt', size: 20, mimeType: 'text/plain' }]);
    // No line is marked as belonging to an attached email: none is printed in a body.
    for (const a of [...result.message.attachments, ...entry(result, 0).message.attachments]) expect('attachedIndex' in a).toBe(false);
    const json = JSON.stringify(result);
    expect(json).not.toContain('OUTER-CONTENT-MARKER');
    expect(json).not.toContain('INNER-CONTENT-MARKER');
  });

  it('converts an HTML-only item with the injected converter', async () => {
    const result = await parseOk({ ...OUTER, attachedItems: [item(inner('A', { bodyText: undefined, bodyHtml: '<p>Inner</p>' }))] });
    expect(entry(result, 0).message.bodyText).toBe('[html 12]');
    expect(entry(result, 0).message.warnings).toEqual(['html-converted-body']);
    // The item was read as an email of its own (task 8.13b-3).
    expect(result.message.warnings).toEqual([]);
  });

  it('an item with no recipients loses its fixed-size properties (dates) in msgreader: flagged, not invented', async () => {
    // msgreader reads an embedded message's property stream from offset 8,
    // not 24: with no recipients the first "entry" it sees is 0 and it stops.
    const result = await parseOk({ ...OUTER, attachedItems: [item(inner('A', { recipients: [] }))] });
    expect(entry(result, 0).message.date.utcMs).toBeNull();
    expect(entry(result, 0).message.warnings).toEqual(['missing-date']);
    expect(entry(result, 0).message.bodyText).toBe('A body.');
  });

  // An HTML body stored as windows-1252 bytes (PidTagHtml, 0x1013): "café" with 0xE9.
  const html1252 = new Uint8Array([...'<p>caf'].map((c) => c.charCodeAt(0)).concat([0xe9], [...'</p>'].map((c) => c.charCodeAt(0))));
  const htmlItem = (extra: Partial<MsgSpec>): MsgSpec =>
    inner('H', { bodyText: undefined, extraBinaries: [{ propId: 0x1013, bytes: html1252 }], codepages: { internet: 1252 }, ...extra });
  const identity = createMsgParser({ htmlToText: (html) => ({ text: html, truncated: false }) });
  const parseIdentity = async (spec: MsgSpec): Promise<OkResult> => {
    const result = await identity.parse({ name: 'html.msg', bytes: buildMsg(spec) });
    if (!result.ok) throw new Error(result.detail);
    return result;
  };

  it('an HTML-only item with no recipients loses its code pages too: its HTML bytes are read as UTF-8 and flagged', async () => {
    const result = await parseIdentity({ ...OUTER, attachedItems: [item(htmlItem({ recipients: [] }))] });
    expect(entry(result, 0).message.bodyText).toBe('<p>caf�</p>');
    expect(entry(result, 0).message.warnings).toEqual(['missing-date', 'html-converted-body', 'text-encoding-uncertain']);
  });

  it('the same HTML-only item with recipients keeps its code page: read correctly, not flagged', async () => {
    const result = await parseIdentity({ ...OUTER, attachedItems: [item(htmlItem({}))] });
    expect(entry(result, 0).message.bodyText).toBe('<p>café</p>');
    expect(entry(result, 0).message.warnings).toEqual(['html-converted-body']);
  });
});

describe('createMsgParser: 8-bit (ANSI) text in attached items', () => {
  // Each character is written as its Latin-1 byte (builder, 'ansi-1252'):
  // 0xE9 is "é" in windows-1252 and "й" in windows-1251.
  const ansi = (name: string, codepages: MsgSpec['codepages'], extra: Partial<MsgSpec> = {}): MsgSpec =>
    inner(name, { strings: 'ansi-1252', codepages, bodyText: 'café', ...extra });

  it('reads an item with its own code page, not the file\'s, with no warning', async () => {
    const result = await parseOk({ ...OUTER, attachedItems: [item(ansi('A', { message: 1251 }))] });
    expect(entry(result, 0).message.bodyText).toBe('cafй');
    expect(entry(result, 0).message.warnings).toEqual([]);
    // The file's own email is not affected.
    expect(result.message.bodyText).toBe('Outer body.');
  });

  it('reads an item with its own code page inside an 8-bit file read with another one', async () => {
    const result = await parseOk({
      ...OUTER,
      strings: 'ansi-1252',
      bodyText: 'Outer café',
      attachedItems: [item(ansi('A', { message: 1251 })), item(ansi('B', { message: 1252 }))],
    });
    expect(result.message.bodyText).toBe('Outer café');
    expect(entry(result, 0).message.bodyText).toBe('cafй');
    expect(entry(result, 1).message.bodyText).toBe('café');
    expect(entry(result, 0).message.warnings).toEqual([]);
    expect(entry(result, 1).message.warnings).toEqual([]);
  });

  it('an item naming no code page is read with windows-1252 (never the UTF-8 body code page) and flagged', async () => {
    // The outer file names only an internet (body) code page, UTF-8.
    const result = await parseOk({ ...OUTER, attachedItems: [item(ansi('A', { message: null, internet: null }))] });
    expect(entry(result, 0).message.bodyText).toBe('café');
    expect(entry(result, 0).message.warnings).toEqual(['text-encoding-uncertain']);
  });

  it('an item with only a UTF-8 internet code page is not read as UTF-8: windows-1252, flagged', async () => {
    const result = await parseOk({ ...OUTER, attachedItems: [item(ansi('A', { message: null, internet: 65001 }))] });
    expect(entry(result, 0).message.bodyText).toBe('café');
    expect(entry(result, 0).message.warnings).toEqual(['text-encoding-uncertain']);
  });

  it('an item with only an 8-bit internet code page is read with it, but flagged (no PidTagMessageCodepage)', async () => {
    const result = await parseOk({ ...OUTER, attachedItems: [item(ansi('A', { message: null, internet: 1251 }))] });
    expect(entry(result, 0).message.bodyText).toBe('cafй');
    expect(entry(result, 0).message.warnings).toEqual(['text-encoding-uncertain']);
  });

  it('an item naming no code page inherits the 8-bit code page of the item holding it, and is flagged', async () => {
    const result = await parseOk({
      ...OUTER,
      attachedItems: [item(ansi('A', { message: 1251 }, { attachedItems: [item(ansi('A1', { message: null, internet: null }))] }))],
    });
    expect(entry(result, 1).message.subject).toBe('A1');
    expect(entry(result, 1).message.bodyText).toBe('cafй');
    expect(entry(result, 1).message.warnings).toEqual(['text-encoding-uncertain']);
    // Its one item was read as an email of its own: no "not expanded" warning (task 8.13b-3).
    expect(entry(result, 0).message.warnings).toEqual([]);
  });

  it('a Unicode item inside an 8-bit one needs no code page and gets no warning', async () => {
    const result = await parseOk({
      ...OUTER,
      attachedItems: [item(ansi('A', { message: 1251 }, { attachedItems: [item(inner('A1', { bodyText: 'Unicode café', codepages: { internet: null } }))] }))],
    });
    expect(entry(result, 1).message.bodyText).toBe('Unicode café');
    expect(entry(result, 1).message.warnings).toEqual([]);
  });

  it('reads the file again for at most 4 other encodings; items needing more are flagged', async () => {
    const codepages = [1250, 1251, 1253, 1255, 1256, 1257];
    const result = await parseOk({
      ...OUTER,
      attachedItems: codepages.map((cp) => item(ansi(`cp${String(cp)}`, { message: cp }))),
    });
    expect(result.attached?.map((e) => [e.message.subject, e.message.warnings])).toEqual([
      ['cp1250', []],
      ['cp1251', []],
      ['cp1253', []],
      ['cp1255', []],
      ['cp1256', ['text-encoding-uncertain']],
      ['cp1257', ['text-encoding-uncertain']],
    ]);
    expect(entry(result, 1).message.bodyText).toBe('cafй');
  });

  /** Crafted msgreader output: a Unicode outer email holding 8-bit items in code page 1251. */
  const craftedAnsi = (subjects: readonly string[]): FieldsData =>
    ({
      dataType: 'msg',
      subject: 'Outer',
      body: 'Outer body.',
      attachments: subjects.map((subject) => ({
        dataType: 'attachment',
        name: subject,
        innerMsgContent: true,
        innerMsgContentFields: {
          dataType: 'msg',
          messageClass: 'IPM.Note',
          subject,
          body: `${subject} body.`,
          messageCodepage: 1251,
          rawProps: [{ propertyTag: '0037001e', value: subject }],
          attachments: [],
          recipients: [],
        },
      })),
      recipients: [],
    }) as unknown as FieldsData;
  const UNCERTAIN = ['missing-date', 'missing-message-id', 'text-encoding-uncertain'];

  it('flags an item that needs another encoding when the file cannot be read again', () => {
    // resultFromFields with crafted msgreader output has no way to read again.
    const result = resultFromFields(craftedAnsi(['A']), 'crafted.msg', 'f'.repeat(64), { htmlToText: stub });
    if (!result.ok) throw new Error(result.detail);
    expect(result.attached?.map((e) => [e.message.subject, e.message.warnings])).toEqual([['A', UNCERTAIN]]);
  });

  it.each<[string, () => FieldsData]>([
    ['returns a msgreader error', () => ({ error: 'x' }) as unknown as FieldsData],
    [
      'throws',
      () => {
        throw new RangeError('Offset is outside the bounds of the DataView');
      },
    ],
  ])('flags the items, keeping the first read, when reading the file again %s (tried once per encoding)', (_label, reread) => {
    let calls = 0;
    const reads = {
      encoding: null,
      reread: (encoding: string): FieldsData => {
        calls++;
        expect(encoding).toBe('windows-1251');
        return reread();
      },
    };
    const result = resultFromFields(craftedAnsi(['A', 'B']), 'crafted.msg', 'f'.repeat(64), { htmlToText: stub }, reads);
    if (!result.ok) throw new Error(result.detail);
    expect(result.message.bodyText).toBe('Outer body.');
    expect(result.attached?.map((e) => [e.message.subject, e.message.bodyText, e.message.warnings])).toEqual([
      ['A', 'A body.', UNCERTAIN],
      ['B', 'B body.', UNCERTAIN],
    ]);
    // The failed read is remembered: B does not try again.
    expect(calls).toBe(1);
  });
});

describe('createMsgParser: only attached emails are read, other Outlook items stay listed', () => {
  it('reads IPM.Note and IPM.Note.* (any letter case); calendar items, contacts, reports and items with no class are listed only, keeping their numbers', async () => {
    const result = await parseOk({
      ...OUTER,
      attachments: [{ fileName: 'plan.txt', content: 'plan' }],
      attachedItems: [
        item(inner('Meeting', { messageClass: 'IPM.Appointment' })),
        item(inner('Mail', { messageClass: 'IPM.Note' })),
        item(inner('Signed', { messageClass: 'ipm.note.SMIME.MultipartSigned' })),
        item(inner('Contact', { messageClass: 'IPM.Contact' })),
        item(inner('Nameless', { messageClass: null })),
        item(inner('Bounce', { messageClass: 'REPORT.IPM.Note.NDR' })),
        item(inner('Lookalike', { messageClass: 'IPM.NoteBook' })),
        item(inner('Task', { messageClass: 'IPM.Task' })),
        item(inner('Last', { messageClass: 'IPM.NOTE' })),
      ],
    });
    // path = the n-th Outlook item line of the holder (plan.txt is not counted).
    expect(shape(result)).toEqual([
      ['Mail', -1, [2]],
      ['Signed', -1, [3]],
      ['Last', -1, [9]],
    ]);
    // The file's own email is unchanged: every item still listed, same warning.
    expect(result.message.attachments.map((a) => a.fileName)).toEqual([
      'plan.txt',
      'Meeting.msg',
      'Mail.msg',
      'Signed.msg',
      'Contact.msg',
      'Nameless.msg',
      'Bounce.msg',
      'Lookalike.msg',
      'Task.msg',
      'Last.msg',
    ]);
    expect(result.message.warnings).toEqual(['forwarded-message-not-expanded']);
  });

  it('does not reach an email attached inside a calendar item', async () => {
    const result = await parseOk({
      ...OUTER,
      attachedItems: [item(inner('Meeting', { messageClass: 'IPM.Schedule.Meeting.Request', attachedItems: [item(inner('Agenda mail'))] })), item(inner('B'))],
    });
    expect(shape(result)).toEqual([['B', -1, [2]]]);
  });

  it(`a skipped non-email does not use up the budget of ${String(MAX_EXPANDED_FORWARDS)} read items`, async () => {
    const calendars = Array.from({ length: MAX_EXPANDED_FORWARDS }, (_, i) => item(inner(`Cal${String(i + 1)}`, { messageClass: 'IPM.Appointment' })));
    const result = await parseOk({ ...OUTER, attachedItems: [...calendars, item(inner('Mail'))] });
    expect(shape(result)).toEqual([['Mail', -1, [MAX_EXPANDED_FORWARDS + 1]]]);
  });

  it('a dropped .msg that is itself a calendar item is still read as before', async () => {
    const result = await parseOk({ ...OUTER, messageClass: 'IPM.Appointment' });
    expect(result.message.subject).toBe('Outer');
    expect(result.message.bodyText).toBe('Outer body.');
  });
});

describe('createMsgParser: an attached item that cannot be read stays listed only', () => {
  it('a damaged item (body of the wrong type) is skipped; the file and the next item still load', async () => {
    const damaged = inner('A', { bodyText: undefined, extraBinaries: [{ propId: 0x1000, bytes: new Uint8Array([1, 2, 3]) }] });
    const result = await parseOk({ ...OUTER, attachedItems: [item(damaged), item(inner('B'))] });
    expect(result.message.bodyText).toBe('Outer body.');
    expect(result.message.attachments.map((a) => a.fileName)).toEqual(['A.msg', 'B.msg']);
    // B keeps its number: the damaged one still counts.
    expect(shape(result)).toEqual([['B', -1, [2]]]);
  });

  it('an item with nothing to show gives no empty email', async () => {
    const empty = inner('', { recipients: [], bodyText: undefined, submitTime: undefined, messageId: undefined, sender: { name: '', smtp: '' } });
    const result = await parseOk({ ...OUTER, attachedItems: [item(empty)] });
    expect('attached' in result).toBe(false);
    expect(result.message.attachments).toHaveLength(1);
  });

  it('a minimal item (only a subject) is still an email of its own', async () => {
    const result = await parseOk({ ...OUTER, attachedItems: [{ displayName: 'Earlier order', subject: 'Earlier' }] });
    expect(shape(result)).toEqual([['Earlier', -1, [1]]]);
    expect(entry(result, 0).message.warnings).toEqual(['missing-date', 'no-body', 'missing-message-id']);
  });

  const crafted = (innerFields: unknown): FieldsData =>
    ({
      dataType: 'msg',
      subject: 'Outer',
      body: 'Outer body.',
      attachments: [
        { dataType: 'attachment', name: 'Broken', innerMsgContent: true, innerMsgContentFields: innerFields },
        {
          dataType: 'attachment',
          name: 'Fine',
          innerMsgContent: true,
          innerMsgContentFields: { dataType: 'msg', messageClass: 'IPM.Note', subject: 'Fine', body: 'ok', attachments: [], recipients: [] },
        },
      ],
      recipients: [],
    }) as unknown as FieldsData;

  it.each<[string, unknown]>([
    ['missing inner properties', undefined],
    ['inner properties that are not an object', 'garbage'],
    ['an inner msgreader error', { error: 'bad', messageClass: 'IPM.Note', subject: 'x' }],
    ['no message properties at all', { dataType: 'msg', attachments: [], recipients: [] }],
    ['an email class and nothing else to show', { dataType: 'msg', messageClass: 'IPM.Note', attachments: [], recipients: [] }],
    ['a message class that is not a string', { dataType: 'msg', messageClass: 42, subject: 'x', body: 'y', attachments: [], recipients: [] }],
    [
      'a message class that throws when read',
      Object.defineProperty({ dataType: 'msg', subject: 'x', body: 'y', attachments: [], recipients: [] }, 'messageClass', {
        get() {
          throw new RangeError('Offset is outside the bounds of the DataView');
        },
        enumerable: true,
      }),
    ],
    [
      'a property that throws when read',
      Object.defineProperty({ dataType: 'msg', messageClass: 'IPM.Note', subject: 'x', attachments: [], recipients: [] }, 'body', {
        get() {
          throw new RangeError('Offset is outside the bounds of the DataView');
        },
        enumerable: true,
      }),
    ],
  ])('crafted: %s', (_label, innerFields) => {
    const result = resultFromFields(crafted(innerFields), 'crafted.msg', 'f'.repeat(64), { htmlToText: stub });
    if (!result.ok) throw new Error(result.detail);
    expect(result.message.bodyText).toBe('Outer body.');
    expect(result.message.attachments.map((a) => a.fileName)).toEqual(['Broken.msg', 'Fine.msg']);
    expect(result.attached?.map((e) => [e.message.subject, e.path])).toEqual([['Fine', [2]]]);
  });

  it('crafted: an error outside any one item leaves the file loaded with no attached emails', () => {
    const fields = crafted({ dataType: 'msg', subject: 'x', attachments: [], recipients: [] }) as unknown as { attachments: unknown[] };
    // Put first, its `innerMsgContent` is read twice for the file's own email
    // (buildMessage's check, then attachmentInfo); the attached reader reads
    // it a third time and fails.
    let reads = 0;
    fields.attachments.unshift(
      Object.defineProperty({ dataType: 'attachment', name: 'Odd' }, 'innerMsgContent', {
        get() {
          reads++;
          if (reads > 2) throw new Error('boom');
          return undefined;
        },
        enumerable: true,
      }),
    );
    const result = resultFromFields(fields as unknown as FieldsData, 'crafted.msg', 'f'.repeat(64), { htmlToText: stub });
    if (!result.ok) throw new Error(result.detail);
    expect(result.message.attachments).toHaveLength(3);
    expect('attached' in result).toBe(false);
  });
});
