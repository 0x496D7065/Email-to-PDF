// Self-check of the fixture set: proves manifest.ts describes the fixtures
// correctly BEFORE the real parsers exist (tasks 2.4 and 2.5), so a parser
// test failure later means a parser bug, not a typo in the manifest.
//
// This is NOT the parser: it reads each fixture straight through the libraries
// (postal-mime for .eml, msgreader for .msg) plus our date parser, with the
// simplest possible mapping, and compares the result to the manifest.
// The HTML-to-text step does not exist yet, so HTML-only bodies are checked
// for their raw HTML only.

import MsgReader, { type FieldsData } from '@kenjiuno/msgreader';
import PostalMime, { type Address } from 'postal-mime';
import { describe, expect, it } from 'vitest';
import { parseEmailDate } from '../../src/parsing/date';
import type { ParseWarning } from '../../src/parsing/types';
import { FIXTURES, type ExpectedAddress, type FixtureExpectation } from './manifest';
import { buildMsgView } from './msg/builder';
import { MSG_SPECS } from './msg/specs';

const files = import.meta.glob<string>('./eml/*.eml', { query: '?raw', import: 'default', eager: true });

const stripId = (id: string): string => id.trim().replace(/^<|>$/g, '');
const idList = (text: string | undefined): string[] => (text?.match(/<[^>]+>/g) ?? []).map(stripId);
const sorted = (list: readonly ParseWarning[]): ParseWarning[] => [...list].sort();

function mailboxes(list: readonly Address[] | undefined): ExpectedAddress[] {
  return (list ?? []).flatMap((a) => (a.group ? a.group : [a])).map((m) => ({ name: m.name, address: m.address }));
}

function dateWarnings(utcMs: number | null, zoneKnown: boolean, hadDate: boolean): ParseWarning[] {
  if (!hadDate) return ['missing-date'];
  if (utcMs === null) return ['unparseable-date'];
  return zoneKnown ? [] : ['unknown-time-zone'];
}

/** Text each `tags` value promises in the body (line ends normalized to LF). Kept deliberately simple. */
const TAG_EVIDENCE: Readonly<Record<string, string>> = {
  'quote:outlook-en': '\nSent: ',
  'quote:outlook-fr': '\nEnvoyé : ',
  'quote:outlook-nl': '\nVerzonden: ',
  'quote:gmail-en': ' wrote:\n',
  'quote:gmail-fr': ' a écrit :\n',
  'quote:apple-en': '> On ',
  'quote:dutch-op-schreef': ' schreef ',
  'signature:bob': 'Bob Sample\nSample Furniture',
  'signature:carol': 'Cordialement,',
  'disclaimer:bob': 'DISCLAIMER: ',
};

/**
 * Light check that each tag is backed by the body: "signature:*-dashdash" needs a "-- " line,
 * others their evidence text. Quoted text counts too, so a copy with "> " prefixes stripped is searched as well.
 */
function checkTags(expected: FixtureExpectation, body: string): void {
  const lf = body.replace(/\r\n/g, '\n');
  const text = `${lf}\n\n${lf.replace(/^(?:> ?)+/gm, '')}`;
  for (const tag of expected.tags) {
    if (/^signature:.+-dashdash$/.test(tag)) {
      // Light check: ANY "-- " line satisfies every "*-dashdash" tag; it does not prove whose signature it is.
      expect(text, `${tag}: body should contain a "-- " signature separator line`).toMatch(/(^|\n)-- \n/);
      continue;
    }
    const evidence = TAG_EVIDENCE[tag];
    expect(evidence, `unknown tag "${tag}": add it to TAG_EVIDENCE`).toBeDefined();
    expect(text, `${tag}: body should contain "${evidence ?? ''}"`).toContain(evidence);
  }
}

function checkBody(expected: FixtureExpectation, body: string): void {
  for (const snippet of expected.bodyContains) expect(body, `body should contain "${snippet}"`).toContain(snippet);
  for (const snippet of expected.bodyExcludes ?? []) expect(body, `body must not contain "${snippet}"`).not.toContain(snippet);
  checkTags(expected, body);
}

const emlFixtures = FIXTURES.filter((f) => f.kind === 'eml');
const msgFixtures = FIXTURES.filter((f) => f.kind === 'msg');

describe('manifest matches the .eml fixtures', () => {
  it.each(emlFixtures.map((f) => [f.id, f] as const))('%s', async (id, expected) => {
    const raw = files[`./${id}`];
    if (raw === undefined) throw new Error(`missing file for ${id}`);
    // Fixtures are 7-bit ASCII (checked by the guard), so this gives the exact file bytes.
    const email = await PostalMime.parse(new TextEncoder().encode(raw));

    expect(email.messageId ? stripId(email.messageId) : null).toBe(expected.messageId);
    expect(email.inReplyTo ? stripId(email.inReplyTo) : null).toBe(expected.inReplyTo);
    expect(idList(email.references)).toEqual(expected.references);

    const dateHeader = email.headers.find((h) => h.key === 'date')?.value ?? null;
    const date = parseEmailDate(dateHeader);
    expect(date.utcMs).toBe(expected.date.utcMs);
    expect(date.zoneKnown).toBe(expected.date.zoneKnown);
    if (expected.date.offsetMinutes !== undefined) expect(date.offsetMinutes).toBe(expected.date.offsetMinutes);

    expect(mailboxes(email.from ? [email.from] : [])).toEqual(expected.from);
    expect(mailboxes(email.to)).toEqual(expected.to);
    expect(mailboxes(email.cc)).toEqual(expected.cc);
    expect(email.subject ?? null).toBe(expected.subject); // missing Subject header: null in the manifest
    expect(
      email.attachments.map((a) => ({
        fileName: a.filename,
        mimeType: a.mimeType,
        size: typeof a.content === 'string' ? a.content.length : a.content.byteLength,
      })),
    ).toEqual(expected.attachments);

    const warnings: ParseWarning[] = dateWarnings(date.utcMs, date.zoneKnown, dateHeader !== null);
    if (!email.messageId) warnings.push('missing-message-id');
    if (email.text === undefined && email.html !== undefined) warnings.push('html-converted-body');
    if (email.text === undefined && email.html === undefined) warnings.push('no-body');
    expect(sorted(warnings)).toEqual(sorted(expected.warnings));

    // postal-mime's own joined `email.text` is an independent reference for
    // the body: it is right for the current fixtures, but NOT for every
    // shape. It converts an HTML part next to a text part in multipart/mixed
    // with its own converter, and puts text parts ahead of
    // inline forwarded messages, while the adapter keeps file order and uses
    // our converter (see src/parsing/eml.ts). A fixture of either shape must
    // get an explicit expected body instead of this comparison.
    if (email.text !== undefined) checkBody(expected, email.text);
    else expect(email.html).toContain('<body'); // HTML-only: text conversion is task 2.4's job.
  });
});

/** Reads a built .msg the simplest way msgreader allows. */
function readMsg(id: string): FieldsData {
  const spec = MSG_SPECS.find((s) => s.id === id);
  if (spec === undefined) throw new Error(`no .msg spec ${id}`);
  const reader = new MsgReader(buildMsgView(spec));
  reader.parserConfig = {
    includeRawProps: true,
    ...(spec.strings === 'ansi-1252' ? { ansiEncoding: 'windows-1252' } : {}),
  };
  return reader.getFileData();
}

describe('manifest matches the .msg builder specs', () => {
  it.each(msgFixtures.map((f) => [f.id, f] as const))('%s', (id, expected) => {
    const data = readMsg(id);
    expect(data.dataType).toBe('msg');
    const rawString = (propId: string): string | undefined => {
      const value = data.rawProps?.find((p) => p.propertyTag?.startsWith(propId))?.value;
      return typeof value === 'string' ? value : undefined;
    };

    expect(data.messageId ? stripId(data.messageId) : null).toBe(expected.messageId);
    const inReplyTo = rawString('1042'); // PR_IN_REPLY_TO_ID: not named by msgreader
    expect(inReplyTo ? stripId(inReplyTo) : null).toBe(expected.inReplyTo);
    expect(idList(rawString('1039'))).toEqual(expected.references); // PR_INTERNET_REFERENCES

    const time = data.clientSubmitTime ?? data.messageDeliveryTime;
    expect(time === undefined ? null : Date.parse(time)).toBe(expected.date.utcMs);
    // A .msg time is an exact UTC instant, so the zone is known exactly when a time exists.
    expect(time !== undefined, 'zoneKnown must be true exactly when the .msg has a time').toBe(expected.date.zoneKnown);

    // Exchange senders: senderEmail is the X.500 DN, the SMTP fallback is senderSmtpAddress.
    expect([{ name: data.senderName, address: data.senderSmtpAddress ?? data.senderEmail }]).toEqual(expected.from);
    const recipients = (type: 'to' | 'cc'): ExpectedAddress[] =>
      (data.recipients ?? [])
        .filter((r) => r.recipType === type)
        .map((r) => ({ name: r.name ?? '', address: r.smtpAddress ?? r.email ?? '' }));
    expect(recipients('to')).toEqual(expected.to);
    expect(recipients('cc')).toEqual(expected.cc);
    expect(data.subject ?? null).toBe(expected.subject);
    expect(
      (data.attachments ?? []).map((a) => ({ fileName: a.fileName, mimeType: a.attachMimeTag, size: a.contentLength })),
    ).toEqual(expected.attachments);

    const warnings: ParseWarning[] = time === undefined ? ['missing-date'] : [];
    if (!data.messageId) warnings.push('missing-message-id');
    expect(sorted(warnings)).toEqual(sorted(expected.warnings));

    checkBody(expected, data.body ?? '');
  });

  it('the cross-format duplicate has the same body as its .eml twin (up to line ends)', async () => {
    const raw = files['./eml/11-order-2-bob-outlook-en.eml'] ?? '';
    const email = await PostalMime.parse(new TextEncoder().encode(raw));
    const msgBody = readMsg('msg-09-dup-of-eml-order-2').body ?? '';
    expect(msgBody).toContain('\r\n'); // Outlook stores CRLF
    expect(msgBody.replace(/\r\n/g, '\n').trimEnd()).toBe((email.text ?? '').trimEnd());
  });
});

describe('manifest structure', () => {
  it('each thread has positions 1..n in chronological (utcMs) order', () => {
    const threads = new Map<string, FixtureExpectation[]>();
    for (const f of FIXTURES) {
      if (f.thread && f.duplicateGroup === undefined) threads.set(f.thread.id, [...(threads.get(f.thread.id) ?? []), f]);
    }
    // Duplicates share their original's position; compare one per position.
    for (const f of FIXTURES) {
      if (f.thread && f.duplicateGroup !== undefined) {
        const list = threads.get(f.thread.id) ?? [];
        if (!list.some((g) => g.thread?.position === f.thread?.position)) threads.set(f.thread.id, [...list, f]);
      }
    }
    for (const [, list] of threads) {
      const byTime = [...list].sort((a, b) => (a.date.utcMs ?? 0) - (b.date.utcMs ?? 0));
      expect(byTime.map((f) => f.thread?.position)).toEqual(list.map((_, i) => i + 1));
    }
  });

  it('in each thread, In-Reply-To is the Message-ID of the previous position', () => {
    const threaded = FIXTURES.filter((f) => f.thread !== undefined);
    for (const f of threaded) {
      const position = f.thread?.position ?? 0;
      const previous = threaded.filter((g) => g.thread?.id === f.thread?.id && g.thread?.position === position - 1);
      if (position === 1) expect(f.inReplyTo, `${f.id}: first in thread`).toBeNull();
      else {
        expect(previous.length, `${f.id}: no message at position ${position - 1}`).toBeGreaterThan(0);
        for (const p of previous) expect(f.inReplyTo, `${f.id} should reply to ${p.id}`).toBe(p.messageId);
      }
    }
  });

  it('the "setup" thread really is out of order on disk', () => {
    const setup = FIXTURES.filter((f) => f.thread?.id === 'setup').sort((a, b) => a.id.localeCompare(b.id));
    expect(setup.map((f) => f.thread?.position)).toEqual([3, 1, 4, 2]);
  });
});
