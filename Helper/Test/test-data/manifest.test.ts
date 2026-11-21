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
import { parseEmailDate } from '../../../Source/email-reading/date-header';
import { FIXTURES, type ExpectedAddress, type FixtureExpectation } from './manifest';
import { buildMsgView } from './msg/builder';
import { MSG_SPECS } from './msg/specs';
import type { ParseWarning } from '../../../Header/parsed-email';

const files = import.meta.glob<string>('./eml/*.eml', { query: '?raw', import: 'default', eager: true });

const stripId = (id: string): string => id.trim().replace(/^<|>$/g, '');
const idList = (text: string | undefined): string[] => (text?.match(/<[^>]+>/g) ?? []).map(stripId);
const sorted = (list: readonly ParseWarning[]): ParseWarning[] => [...list].sort();

function mailboxes(list: readonly Address[] | undefined): ExpectedAddress[]
{
    return (list ?? []).flatMap((a) => (a.group ? a.group : [a])).map((m) => ({ name: m.name, address: m.address }));
}

function dateWarnings(utcMs: number | null, zoneKnown: boolean, hadDate: boolean): ParseWarning[]
{
    if (!hadDate)
    {
        return ['missing-date'];
    }
    if (utcMs === null)
    {
        return ['unparseable-date'];
    }
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
    // Task 9.9a (the phone forward fixtures): a French forward marker, a flat mobile attribution
    // (its text under it at the same depth, after a blank line) and the workshop's signature.
    'quote:forward-fr': '---------- Message transféré ----------\n',
    'quote:mobile-fr': ' a écrit :\n\nChère Madame,',
    'signature:workshop': 'Mobilier de bureau sur mesure',
};

/**
 * Light check that each tag is backed by the body: "signature:*-dashdash" needs a "-- " line,
 * others their evidence text. Quoted text counts too, so a copy with "> " prefixes stripped is searched as well.
 */
function checkTags(expected: FixtureExpectation, body: string): void
{
    const lfBody = body.replace(/\r\n/g, '\n');
    const text = `${lfBody}\n\n${lfBody.replace(/^(?:> ?)+/gm, '')}`;
    for (const tag of expected.tags)
    {
        if (/^signature:.+-dashdash$/.test(tag))
        {
            // Light check: ANY "-- " line satisfies every "*-dashdash" tag; it does not prove whose signature it is.
            expect(text, `${tag}: body should contain a "-- " signature separator line`).toMatch(/(^|\n)-- \n/);
            continue;
        }
        if (tag === 'quotes-not-in-set')
        {
            // A property of the set, not of the body: checked in Source/thread-analysis/analyze-thread.fixtures.test.ts.
            continue;
        }
        if (tag === 'own-text:none')
        {
            // No own text: the body starts with a forward marker line ("---------- ... ----------").
            expect(lfBody.trimStart(), `${tag}: body should start with a forward marker line`).toMatch(/^-{5,} .+ -{5,}\n/u);
            continue;
        }
        const evidence = TAG_EVIDENCE[tag];
        expect(evidence, `unknown tag "${tag}": add it to TAG_EVIDENCE`).toBeDefined();
        expect(text, `${tag}: body should contain "${evidence ?? ''}"`).toContain(evidence);
    }
}

/** HTML-only .msg snippets that the raw HTML splits with inline tags (e.g. `<b>`). */
const SNIPPETS_NEEDING_TAG_REMOVAL = new Set(['The showroom visit is on Friday 25 April at 14:00.']);

function checkBody(expected: FixtureExpectation, body: string): void
{
    for (const snippet of expected.bodyContains)
    {
        expect(body, `body should contain "${snippet}"`).toContain(snippet);
    }
    for (const snippet of expected.bodyExcludes ?? [])
    {
        expect(body, `body must not contain "${snippet}"`).not.toContain(snippet);
    }
    checkTags(expected, body);
}

const emlFixtures = FIXTURES.filter((f) => f.kind === 'eml');
const msgFixtures = FIXTURES.filter((f) => f.kind === 'msg');

describe('manifest matches the .eml fixtures', () =>
{
    it.each(emlFixtures.map((f) => [f.id, f] as const))('%s', async (id, expected) =>
    {
        const raw = files[`./${id}`];
        if (raw === undefined)
        {
            throw new Error(`missing file for ${id}`);
        }
        // Fixtures are 7-bit ASCII (checked by the guard), so this gives the exact file bytes.
        const email = await PostalMime.parse(new TextEncoder().encode(raw));

        expect(email.messageId ? stripId(email.messageId) : null).toBe(expected.messageId);
        expect(email.inReplyTo ? stripId(email.inReplyTo) : null).toBe(expected.inReplyTo);
        expect(idList(email.references)).toEqual(expected.references);

        const dateHeader = email.headers.find((h) => h.key === 'date')?.value ?? null;
        const date = parseEmailDate(dateHeader);
        expect(date.utcMs).toBe(expected.date.utcMs);
        expect(date.zoneKnown).toBe(expected.date.zoneKnown);
        if (expected.date.offsetMinutes !== undefined)
        {
            expect(date.offsetMinutes).toBe(expected.date.offsetMinutes);
        }

        expect(mailboxes(email.from ? [email.from] : [])).toEqual(expected.from);
        expect(mailboxes(email.to)).toEqual(expected.to);
        expect(mailboxes(email.cc)).toEqual(expected.cc);
        expect(mailboxes(email.bcc)).toEqual(expected.bcc);
        // Sender: kept only if its address is not a From address (letter case ignored).
        const fromAddresses = expected.from.map((f) => f.address.toLowerCase());
        const sender = email.sender && !fromAddresses.includes((email.sender.address ?? '').toLowerCase()) ? email.sender : undefined;
        expect(sender && { name: sender.name, address: sender.address ?? '' }).toEqual(expected.sender);
        expect(email.subject ?? null).toBe(expected.subject); // missing Subject header: null in the manifest
        expect(
            email.attachments.map((a) => ({
                fileName: a.filename,
                mimeType: a.mimeType,
                size: typeof a.content === 'string' ? a.content.length : a.content.byteLength,
            })),
        ).toEqual(expected.attachments);

        const warnings: ParseWarning[] = dateWarnings(date.utcMs, date.zoneKnown, dateHeader !== null);
        if (!email.messageId)
        {
            warnings.push('missing-message-id');
        }
        if (email.text === undefined && email.html !== undefined)
        {
            warnings.push('html-converted-body');
        }
        if (email.text === undefined && email.html === undefined)
        {
            warnings.push('no-body');
        }
        expect(sorted(warnings)).toEqual(sorted(expected.warnings));

        // postal-mime's own joined `email.text` is an independent reference for
        // the body: it is right for the current fixtures, but NOT for every
        // shape. It converts an HTML part next to a text part in multipart/mixed
        // with its own converter, and puts text parts ahead of
        // inline forwarded messages, while the adapter keeps file order and uses
        // our converter (see Source/email-reading/eml-parser.ts). A fixture of either shape must
        // get an explicit expected body instead of this comparison.
        if (email.text !== undefined)
        {
            checkBody(expected, email.text);
        }
        else
        {
            expect(email.html).toContain('<body'); // HTML-only: text conversion is task 2.4's job.
        }
    });
});

/** Reads a built .msg the simplest way msgreader allows. */
function readMsg(id: string): FieldsData
{
    const spec = MSG_SPECS.find((s) => s.id === id);
    if (spec === undefined)
    {
        throw new Error(`no .msg spec ${id}`);
    }
    const reader = new MsgReader(buildMsgView(spec));
    reader.parserConfig = {
        includeRawProps: true,
        ...(spec.strings === 'ansi-1252' ? { ansiEncoding: 'windows-1252' } : {}),
    };
    return reader.getFileData();
}

describe('manifest matches the .msg builder specs', () =>
{
    it.each(msgFixtures.map((f) => [f.id, f] as const))('%s', (id, expected) =>
    {
        const data = readMsg(id);
        expect(data.dataType).toBe('msg');
        const rawString = (propId: string): string | undefined =>
        {
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
        const actual = { name: data.senderName, address: data.senderSmtpAddress ?? data.senderEmail };
        // "Sent representing" (0x0042 name, 0x0065 address, SMTP fallback
        // sentRepresentingSmtpAddress) is the From when present; a missing SMTP
        // fallback means the same mailbox as the sender in these specs.
        const repName = rawString('0042');
        const represented =
            repName === undefined
                ? undefined
                : { name: repName, address: data.sentRepresentingSmtpAddress ?? (rawString('0065') === data.senderEmail ? actual.address : rawString('0065')) };
        expect([represented ?? actual]).toEqual(expected.from);
        const onBehalf = represented !== undefined && represented.address?.toLowerCase() !== actual.address?.toLowerCase();
        expect(onBehalf ? actual : undefined).toEqual(expected.sender);
        const recipients = (type: 'to' | 'cc' | 'bcc'): ExpectedAddress[] =>
            (data.recipients ?? [])
                .filter((r) => r.recipType === type)
                .map((r) => ({ name: r.name ?? '', address: r.smtpAddress ?? r.email ?? '' }));
        expect(recipients('to')).toEqual(expected.to);
        expect(recipients('cc')).toEqual(expected.cc);
        // Simplest mapping: an empty recipient row (no name, no address) is not a recipient.
        expect(recipients('bcc').filter((r) => r.name !== '' || r.address !== '')).toEqual(expected.bcc);
        expect(data.subject ?? null).toBe(expected.subject);
        expect(
            (data.attachments ?? []).map((a) => ({ fileName: a.fileName, mimeType: a.attachMimeTag, size: a.contentLength })),
        ).toEqual(expected.attachments);

        const warnings: ParseWarning[] = time === undefined ? ['missing-date'] : [];
        if (!data.messageId)
        {
            warnings.push('missing-message-id');
        }
        // The builder writes an HTML body as UTF-8 bytes (PidTagHtml).
        const html = data.html === undefined ? undefined : new TextDecoder().decode(data.html);
        const htmlOnly = (data.body ?? '').trim() === '' && html !== undefined;
        if (htmlOnly)
        {
            warnings.push('html-converted-body');
        }
        expect(sorted(warnings)).toEqual(sorted(expected.warnings));

        if (htmlOnly)
        {
            // HTML-only: text conversion is checked by the adapter tests and e2e.
            // Here only the snippets that appear verbatim in the raw HTML are checked;
            // the ones split by inline tags exist only after conversion.
            expect(html).toContain('<body');
            for (const snippet of expected.bodyContains)
            {
                if (SNIPPETS_NEEDING_TAG_REMOVAL.has(snippet))
                {
                    continue;
                }
                expect(html, `stored HTML should contain "${snippet}"`).toContain(snippet);
            }
        }
        else
        {
            checkBody(expected, data.body ?? '');
        }
    });

    it('the cross-format duplicate has the same body as its .eml twin (up to line ends)', async () =>
    {
        const raw = files['./eml/11-order-2-bob-outlook-en.eml'] ?? '';
        const email = await PostalMime.parse(new TextEncoder().encode(raw));
        const msgBody = readMsg('msg-09-dup-of-eml-order-2').body ?? '';
        expect(msgBody).toContain('\r\n'); // Outlook stores CRLF
        expect(msgBody.replace(/\r\n/g, '\n').trimEnd()).toBe((email.text ?? '').trimEnd());
    });
});

describe('manifest structure', () =>
{
    it('each thread has positions 1..n in chronological (utcMs) order', () =>
    {
        const threads = new Map<string, FixtureExpectation[]>();
        for (const fixture of FIXTURES)
        {
            if (fixture.thread && fixture.duplicateGroup === undefined)
            {
                threads.set(fixture.thread.id, [...(threads.get(fixture.thread.id) ?? []), fixture]);
            }
        }
        // Duplicates share their original's position; compare one per position.
        for (const fixture of FIXTURES)
        {
            if (fixture.thread && fixture.duplicateGroup !== undefined)
            {
                const list = threads.get(fixture.thread.id) ?? [];
                if (!list.some((g) => g.thread?.position === fixture.thread?.position))
                {
                    threads.set(fixture.thread.id, [...list, fixture]);
                }
            }
        }
        for (const [, list] of threads)
        {
            const byTime = [...list].sort((a, b) => (a.date.utcMs ?? 0) - (b.date.utcMs ?? 0));
            expect(byTime.map((f) => f.thread?.position)).toEqual(list.map((_, i) => i + 1));
        }
    });

    it('in each thread, In-Reply-To is the Message-ID of the previous position', () =>
    {
        const threaded = FIXTURES.filter((f) => f.thread !== undefined);
        for (const fixture of threaded)
        {
            const position = fixture.thread?.position ?? 0;
            const previous = threaded.filter((g) => g.thread?.id === fixture.thread?.id && g.thread?.position === position - 1);
            if (position === 1)
            {
                expect(fixture.inReplyTo, `${fixture.id}: first in thread`).toBeNull();
            }
            else
            {
                expect(previous.length, `${fixture.id}: no message at position ${position - 1}`).toBeGreaterThan(0);
                for (const earlier of previous)
                {
                    expect(fixture.inReplyTo, `${fixture.id} should reply to ${earlier.id}`).toBe(earlier.messageId);
                }
            }
        }
    });

    it('the "setup" thread really is out of order on disk', () =>
    {
        const setup = FIXTURES.filter((f) => f.thread?.id === 'setup').sort((a, b) => a.id.localeCompare(b.id));
        expect(setup.map((f) => f.thread?.position)).toEqual([3, 1, 4, 2]);
    });
});
