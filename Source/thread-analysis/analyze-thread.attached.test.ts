// The engine with emails attached inside dropped files (task 8.13b-3, user
// decisions 2026-11-10): every attached email is an engine message of its
// own, de-duplicated, ordered and folded like a dropped file's email (Q6-Q8),
// and EngineAttached keeps where it came from. The files are built in memory
// from synthetic text and read by the real parsers (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { buildMsg, type MsgSpec } from '../../Helper/Test/test-data/msg/builder';
import { createEmlParser } from '../email-reading/eml-parser';
import { FORWARDED_SEPARATOR } from '../email-reading/forwarded-block';
import type { HtmlToTextResult } from '../email-reading/html-to-text';
import { createMsgParser } from '../email-reading/msg-parser';
import { attachedAt, DEFAULT_PARTS, runEngine } from './analyze-thread';
import type { OverlapInput } from './overlap-quote-detection';
import { checkSegments, joinSegments } from './fold-segments';
import type { NormalizedMessage, ParseResult } from '../../Header/parsed-email';
import type { EngineMessage, EngineResult } from '../../Header/thread-analysis-result';

const crlf = (...lines: string[]): string => lines.join('\r\n');
const stub = (html: string): HtmlToTextResult => ({ text: `[html ${String(html.length)}]`, truncated: false });
const emlParser = createEmlParser({ htmlToText: stub });
const msgParser = createMsgParser({ htmlToText: stub });

const plain = (text: string): string => crlf('Content-Type: text/plain; charset=utf-8', '', text);
const mixed = (boundary: string, ...parts: string[]): string =>
    crlf(`Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts.flatMap((p) => [`--${boundary}`, p]), `--${boundary}--`, '');
const rfc822 = (message: string, disposition?: string): string =>
    crlf('Content-Type: message/rfc822', ...(disposition === undefined ? [] : [`Content-Disposition: ${disposition}`]), '', message);
const AS_FILE = 'attachment; filename="forwarded.eml"';

/** An email's header lines (no Date line when `date` is null). */
const head = (name: string, date: string | null, ...extra: string[]): string[] => [
    `From: ${name} <${name}@example.test>`,
    'To: Team <team@example.test>',
    ...(date === null ? [] : [`Date: ${date}`]),
    `Subject: ${name} subject`,
    `Message-ID: <${name}@example.test>`,
    'MIME-Version: 1.0',
    ...extra,
];
/** A simple email: header lines and a plain body. */
const simple = (name: string, date: string | null, body: string, ...extra: string[]): string => crlf(...head(name, date, ...extra), '', body);
/** An email whose body is a multipart/mixed of `parts`. */
const holding = (name: string, date: string | null, ...parts: string[]): string => crlf(...head(name, date), mixed(`b-${name}`, ...parts));

const A_BODY = 'The quarterly figures for the north warehouse are attached and the totals were checked twice by the team.';
const B_BODY = 'Please confirm the delivery window for the twelve oak desks before Friday so the movers can plan the route.';

async function parseEml(name: string, text: string): Promise<ParseResult>
{
    return emlParser.parse({ name, bytes: new TextEncoder().encode(text) });
}
async function parseMsg(name: string, spec: MsgSpec): Promise<ParseResult>
{
    return msgParser.parse({ name, bytes: buildMsg(spec) });
}
const ok = (result: ParseResult): Extract<ParseResult, { ok: true }> =>
{
    if (!result.ok)
    {
        throw new Error(result.detail);
    }
    return result;
};
const bySubject = (out: EngineResult, subject: string): EngineMessage =>
{
    const message = out.messages.find((x) => x.message.subject === subject);
    if (message === undefined)
    {
        throw new Error(`no message ${subject}`);
    }
    return message;
};
const subjects = (out: EngineResult): string[] => out.messages.map((m) => m.message.subject);

/** Every kept message is fully recoverable and every input position is held exactly once. */
function expectWhole(out: EngineResult): void
{
    for (const message of out.messages)
    {
        expect(checkSegments(message.message.bodyText, message.segments)).toEqual([]);
        expect(joinSegments(message.message.bodyText, message.segments)).toBe(message.message.bodyText);
    }
    const seen = new Set<number>();
    for (const message of out.messages)
    {
        for (const i of [message.index, ...message.duplicates.map((d) => d.index)])
        {
            expect(seen.has(i)).toBe(false);
            seen.add(i);
        }
    }
    expect(seen.size).toBe(out.counts.messagesFound);
    expect(out.positionByIndex.filter((p) => p !== null)).toHaveLength(out.counts.messagesFound);
}

describe('runEngine: attached emails are messages of their own', () =>
{
    it('an inline forward (.eml): own message after the file in input order, places on its parent, ordered by date', async () =>
    {
        const parent = ok(await parseEml('parent.eml', holding('alice', 'Tue, 3 Jun 2025 14:00:00 +0200', plain('See below.'), rfc822(simple('bob', 'Mon, 2 Jun 2025 10:00:00 +0200', A_BODY)))));
        const out = runEngine([parent]);
        expectWhole(out);
        expect(out.counts).toMatchObject({ filesGiven: 1, messagesFound: 2, duplicatesMerged: 0, filesFailed: 0, undated: 0 });
        expect(subjects(out)).toEqual(['bob subject', 'alice subject']);
        const a = bySubject(out, 'bob subject');
        expect(a.index).toBe(1);
        expect(a.order).toBe('by-date');
        expect(a.message.source).toMatchObject({ fileName: 'parent.eml', attachedPath: [1] });
        const entry = attachedAt(out, 1)!;
        expect(entry).toMatchObject({ index: 1, parentIndex: 0, fileIndex: 0, path: [1], names: [''] });
        expect(entry.places).toHaveLength(1);
        const parentMessage = bySubject(out, 'alice subject');
        const block = parentMessage.message.bodyText.slice(entry.places[0]!.start, entry.places[0]!.end);
        expect(block.startsWith(FORWARDED_SEPARATOR)).toBe(true);
        expect(block.endsWith(a.message.bodyText)).toBe(true);
        expect(block).toContain(A_BODY);
        expect(attachedAt(out, 0)).toBeUndefined();
        // The overlap detector folds the forward's text in the parent, linked to the attached email (Q6).
        const offset = parentMessage.message.bodyText.indexOf(A_BODY);
        const covering = parentMessage.segments.filter((s) => s.start <= offset && s.end > offset);
        expect(covering.some((s) => s.folded && s.related.includes(1))).toBe(true);
    });

    it('an email sent as an attachment (.eml): own message, its name, no place', async () =>
    {
        const parent = ok(await parseEml('parent.eml', holding('alice', 'Tue, 3 Jun 2025 14:00:00 +0200', plain('Attached.'), rfc822(simple('bob', 'Mon, 2 Jun 2025 10:00:00 +0200', A_BODY), AS_FILE))));
        const out = runEngine([parent]);
        expectWhole(out);
        expect(subjects(out)).toEqual(['bob subject', 'alice subject']);
        expect(attachedAt(out, 1)).toMatchObject({ parentIndex: 0, path: [1], names: ['forwarded.eml'], places: [] });
    });

    it('an attached Outlook email (.msg): own message, the line name, no place', async () =>
    {
        const inner: MsgSpec = {
            id: 'inner',
            description: 'inner',
            strings: 'unicode',
            subject: 'Inner item',
            sender: { name: 'Bob', smtp: 'bob@example.test' },
            recipients: [{ type: 'to', name: 'Team', smtp: 'team@example.test' }],
            bodyText: B_BODY,
            submitTime: '2025-06-02T08:00:00Z',
            messageId: '<inner-item@example.test>',
        };
        const outer: MsgSpec = { ...inner, id: 'outer', subject: 'Outer item', bodyText: 'See the attached email.', submitTime: '2025-06-03T08:00:00Z', messageId: '<outer-item@example.test>', attachedItems: [{ displayName: 'Inner item', message: inner }] };
        const out = runEngine([ok(await parseMsg('outer.msg', outer))]);
        expectWhole(out);
        expect(subjects(out)).toEqual(['Inner item', 'Outer item']);
        expect(attachedAt(out, 1)).toMatchObject({ parentIndex: 0, fileIndex: 0, path: [1], names: ['Inner item.msg'], places: [] });
        // Every item read: the parent no longer says a forwarded email is not shown.
        expect(bySubject(out, 'Outer item').parserWarnings).not.toContain('forwarded-message-not-expanded');
    });

    it('nested inline forwards: every level is a message, names and places chained', async () =>
    {
        const b = simple('carol', 'Sun, 1 Jun 2025 09:00:00 +0200', B_BODY);
        const a = holding('bob', 'Mon, 2 Jun 2025 10:00:00 +0200', plain(A_BODY), crlf('Content-Type: message/rfc822; name="inner.eml"', '', b));
        const parent = ok(await parseEml('parent.eml', holding('alice', 'Tue, 3 Jun 2025 14:00:00 +0200', plain('See below.'), rfc822(a))));
        const out = runEngine([parent]);
        expectWhole(out);
        expect(subjects(out)).toEqual(['carol subject', 'bob subject', 'alice subject']);
        expect(attachedAt(out, 1)).toMatchObject({ parentIndex: 0, path: [1], names: [''] });
        const inner = attachedAt(out, 2)!;
        expect(inner).toMatchObject({ parentIndex: 1, fileIndex: 0, path: [1, 1], names: ['', 'inner.eml'] });
        expect(inner.places.map((p) => p.holderIndex)).toEqual([1, 0]);
        for (const place of inner.places)
        {
            const holder = out.messages[out.positionByIndex[place.holderIndex]!]!.message.bodyText;
            expect(holder.slice(place.start, place.end).endsWith(bySubject(out, 'carol subject').message.bodyText)).toBe(true);
        }
    });

    it('a duplicate of a dropped file: the dropped copy is kept, the attached one merged into it (Q8)', async () =>
    {
        const copy = simple('bob', 'Mon, 2 Jun 2025 10:00:00 +0200', A_BODY);
        const parent = ok(await parseEml('parent.eml', holding('alice', 'Tue, 3 Jun 2025 14:00:00 +0200', plain('See below.'), rfc822(copy))));
        const dropped = ok(await parseEml('bob.eml', copy));
        for (const results of [
            [parent, dropped],
            [dropped, parent],
        ])
        {
            const out = runEngine(results);
            expectWhole(out);
            expect(out.counts).toMatchObject({ filesGiven: 2, messagesFound: 3, duplicatesMerged: 1 });
            const kept = bySubject(out, 'bob subject');
            expect(kept.message.source.fileName).toBe('bob.eml');
            expect(kept.message.source.attachedPath).toBeUndefined();
            expect(kept.duplicates.map((d) => d.source.attachedPath)).toEqual([[1]]);
            expect(out.positionByIndex[2]).toBe(out.messages.indexOf(kept));
        }
    });

    it('D2 (user decision, review round 4): the dropped file wins even when the attached copy holds more header data (a Bcc line); keptShowsHeader says so', async () =>
    {
        const parent = ok(await parseEml('parent.eml', holding('alice', 'Tue, 3 Jun 2025 14:00:00 +0200', plain('See below.'), rfc822(simple('bob', 'Mon, 2 Jun 2025 10:00:00 +0200', A_BODY, 'Bcc: boss@example.test')))));
        const dropped = ok(await parseEml('bob.eml', simple('bob', 'Mon, 2 Jun 2025 10:00:00 +0200', A_BODY)));
        for (const results of [
            [dropped, parent],
            [parent, dropped],
        ])
        {
            const out = runEngine(results);
            expectWhole(out);
            expect(out.counts).toMatchObject({ messagesFound: 3, duplicatesMerged: 1 });
            const kept = bySubject(out, 'bob subject');
            expect(kept.message.source.fileName).toBe('bob.eml');
            expect(kept.message.source.attachedPath).toBeUndefined();
            expect(kept.message.bcc).toEqual([]);
            expect(kept.duplicates.map((d) => d.source.attachedPath)).toEqual([[1]]);
            // The attached copy's Bcc is not in the kept copy's header rows: its block's header lines stay printed.
            expect(out.attached?.[0]?.keptShowsHeader).toBe(false);
        }
        // The same header data: the dropped copy, and its rows show everything.
        const same = runEngine([ok(await parseEml('parent.eml', holding('alice', 'Tue, 3 Jun 2025 14:00:00 +0200', plain('See below.'), rfc822(simple('bob', 'Mon, 2 Jun 2025 10:00:00 +0200', A_BODY))))), dropped]);
        expect(same.attached?.[0]?.keptShowsHeader).toBe(true);
        // Two attached copies (no dropped one): the general rule, the copy with the Bcc line is kept.
        const twoAttached = runEngine([
            parent,
            ok(await parseEml('other.eml', holding('dave', 'Wed, 4 Jun 2025 14:00:00 +0200', plain('Also below.'), rfc822(simple('bob', 'Mon, 2 Jun 2025 10:00:00 +0200', A_BODY))))),
        ]);
        expect(bySubject(twoAttached, 'bob subject').message.bcc.map((m) => m.address)).toEqual(['boss@example.test']);
    });

    it('S1 (review round 4): a holder merged into another copy of it: its attached emails\' places move to the kept copy', async () =>
    {
        const text = holding('alice', 'Tue, 3 Jun 2025 14:00:00 +0200', plain('See below.'), rfc822(simple('bob', 'Mon, 2 Jun 2025 10:00:00 +0200', A_BODY)));
        const withList = ok(await parseEml('one.eml', text));
        // The same email from a file whose attached list was not read (another parser, say), its body
        // written with LF line ends and trailing spaces: equal as de-duplication compares bodies.
        const body = withList.message.bodyText.replace(/\r\n/gu, '\n').replace(/\n/gu, '  \n');
        const noList: ParseResult = { ok: true, message: { ...withList.message, bodyText: body, bcc: [{ name: '', address: 'archive@example.test' }], source: { ...withList.message.source, fileName: 'two.eml', sha256: '0'.repeat(64) } } };
        const out = runEngine([withList, noList]);
        expectWhole(out);
        const kept = bySubject(out, 'alice subject');
        // The copy with the Bcc line covers the other one: it is kept.
        expect(kept.index).toBe(1);
        const place = attachedAt(out, 2)!.places[0]!;
        expect(place.holderIndex).toBe(1);
        const block = kept.message.bodyText.slice(place.start, place.end);
        expect(block.startsWith(FORWARDED_SEPARATOR)).toBe(true);
        expect(block.trimEnd().endsWith(A_BODY)).toBe(true);
    });

    it('an undated attached email is placed just before its parent, flagged (Q7); nested ones before theirs', async () =>
    {
        const b = simple('carol', null, B_BODY);
        const a = holding('bob', null, plain(A_BODY), rfc822(b));
        const parent = ok(await parseEml('parent.eml', holding('alice', 'Tue, 3 Jun 2025 14:00:00 +0200', plain('See below.'), rfc822(a))));
        const later = ok(await parseEml('later.eml', simple('dave', 'Wed, 4 Jun 2025 09:00:00 +0200', 'A later email.')));
        const earlier = ok(await parseEml('earlier.eml', simple('erin', 'Sun, 1 Jun 2025 09:00:00 +0200', 'An earlier email.')));
        const undatedTop = ok(await parseEml('undated.eml', simple('frank', null, 'No date here.')));
        const out = runEngine([later, parent, undatedTop, earlier]);
        expectWhole(out);
        expect(subjects(out)).toEqual(['erin subject', 'carol subject', 'bob subject', 'alice subject', 'dave subject', 'frank subject']);
        expect(out.messages.map((m) => m.order)).toEqual(['by-date', 'before-parent', 'before-parent', 'by-date', 'by-date', 'file-order']);
        expect(out.counts.undated).toBe(3);
        expect(bySubject(out, 'bob subject').parserWarnings).toContain('missing-date');
        // The timeline still holds every message once, in list order.
        expect(out.timeline.filter((e) => e.kind === 'message').map((e) => (e.kind === 'message' ? e.position : -1))).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('an undated attached email whose parent is undated too goes before it, at the end', async () =>
    {
        const parent = ok(await parseEml('parent.eml', holding('alice', null, plain('See below.'), rfc822(simple('bob', null, A_BODY), AS_FILE))));
        const dated = ok(await parseEml('dated.eml', simple('dave', 'Wed, 4 Jun 2025 09:00:00 +0200', 'A dated email.')));
        const out = runEngine([parent, dated]);
        expect(subjects(out)).toEqual(['dave subject', 'bob subject', 'alice subject']);
        expect(out.messages.map((m) => m.order)).toEqual(['by-date', 'before-parent', 'file-order']);
    });

    it('the same file added twice: one copy of each email, the attached copies merged', async () =>
    {
        const text = holding('alice', 'Tue, 3 Jun 2025 14:00:00 +0200', plain('See below.'), rfc822(simple('bob', 'Mon, 2 Jun 2025 10:00:00 +0200', A_BODY)));
        const out = runEngine([ok(await parseEml('one.eml', text)), ok(await parseEml('two.eml', text))]);
        expectWhole(out);
        expect(subjects(out)).toEqual(['bob subject', 'alice subject']);
        expect(out.counts).toMatchObject({ filesGiven: 2, messagesFound: 4, duplicatesMerged: 2 });
        expect(out.attached?.map((e) => [e.index, e.fileIndex, e.parentIndex])).toEqual([
            [2, 0, 0],
            [3, 1, 1],
        ]);
    });

    it('no attached email: no `attached` key, positionByIndex as long as the input', async () =>
    {
        const out = runEngine([ok(await parseEml('one.eml', simple('bob', 'Mon, 2 Jun 2025 10:00:00 +0200', A_BODY)))]);
        expect('attached' in out).toBe(false);
        expect(out.positionByIndex).toHaveLength(1);
    });

    it('skips attached entries that break the contract, with the ones inside them; drops a place that is not a range of its holder', () =>
    {
        const message = (subject: string, bodyText: string): NormalizedMessage => ({
            ...ok(TOP_RESULT).message,
            subject,
            bodyText,
            messageId: `${subject}@example.test`,
        });
        const top = ok(TOP_RESULT);
        const good = { message: message('good', 'Good.'), parent: -1, path: [1], name: 'g.eml', places: [{ holder: -1, start: 0, end: 99_999 }] };
        const bad = { message: message('bad', 'Bad.'), parent: 5, path: [2], name: 'b.eml', places: [] };
        const child = { message: message('child', 'Child.'), parent: 1, path: [2, 1], name: '', places: [] };
        const wrongPath = { message: message('wrong path', 'Wrong.'), parent: 0, path: [9, 1], name: '', places: [] };
        const result = { ...top, attached: [good, bad, child, wrongPath] } as unknown as ParseResult;
        const out = runEngine([result]);
        expectWhole(out);
        expect(out.messages.map((m) => m.message.subject).sort()).toEqual(['bob subject', 'good']);
        expect(out.attached).toEqual([{ index: 1, parentIndex: 0, fileIndex: 0, path: [1], names: ['g.eml'], places: [], keptShowsHeader: true }]);
    });
});

describe('runEngine: an email holding an attached email always quotes it (task 8.13b-3, review round 2, M1)', () =>
{
    const UNIQUE_A = 'UNIQUE-A the north warehouse inventory count finished early and every shelf label was replaced this week.';
    /** Bob's email: its own text, then an inline forward of Carol's. */
    const aWithForward = (date: string | null): string => holding('bob', date, plain(UNIQUE_A), rfc822(simple('carol', 'Sun, 1 Jun 2025 09:00:00 +0200', B_BODY)));
    /** Every folded segment of `m` linked to message `related` (an input position). */
    const foldsFrom = (out: EngineResult, message: EngineMessage, related: number): number =>
        message.segments.filter((s) => s.folded && s.related.some((i) => out.positionByIndex[i] === out.positionByIndex[related])).length;
    /** Runs the engine and records what the overlap detector was given. */
    const spied = (results: readonly ParseResult[]): { out: EngineResult; given: OverlapInput[] } =>
    {
        let given: OverlapInput[] = [];
        const out = runEngine(results, {
            ...DEFAULT_PARTS,
            detectQuotedOverlap: (messages) =>
            {
                given = [...messages];
                return DEFAULT_PARTS.detectQuotedOverlap(messages);
            },
        });
        return { out, given };
    };
    const holdsOf = (given: readonly OverlapInput[], index: number): number[] => [...(given.find((g) => g.index === index)?.holds ?? [])].sort((a, b) => a - b);

    it('repro 1: an attached email dated after its holder (no zone) is not folded as quoted from it; the holder\'s block is', async () =>
    {
        const parent = ok(await parseEml('parent.eml', holding('alice', 'Mon, 2 Jun 2025 10:30:00 +0200', plain('See below.'), rfc822(aWithForward('Mon, 2 Jun 2025 10:00:00')))));
        const { out, given } = spied([parent]);
        expectWhole(out);
        // Bob's email (no zone: read as UTC) comes after Alice's.
        expect(subjects(out)).toEqual(['carol subject', 'alice subject', 'bob subject']);
        const bob = bySubject(out, 'bob subject');
        expect(foldsFrom(out, bob, 0)).toBe(0);
        expect(bob.segments.filter((s) => !s.folded).map((s) => bob.message.bodyText.slice(s.start, s.end)).join('')).toContain(UNIQUE_A);
        // Alice's copy of Bob's text is folded as quoted from Bob (input position 1).
        const alice = bySubject(out, 'alice subject');
        expect(foldsFrom(out, alice, 1)).toBeGreaterThan(0);
        // What the detector was given: Alice holds Bob and Carol, Bob holds Carol, Carol holds none.
        expect(holdsOf(given, 0)).toEqual([1, 2]);
        expect(holdsOf(given, 1)).toEqual([2]);
        expect(given.find((g) => g.index === 2)).not.toHaveProperty('holds');
    });

    it('repro 2: undated, with a copy of the attached email dropped after its holder: the kept copy (the dropped file) is held too', async () =>
    {
        const parent = ok(await parseEml('parent.eml', holding('alice', null, plain('See below.'), rfc822(aWithForward(null)))));
        const dropped = ok(await parseEml('a.eml', aWithForward(null)));
        const { out, given } = spied([parent, dropped]);
        expectWhole(out);
        const bob = bySubject(out, 'bob subject');
        expect(bob.message.source.fileName).toBe('a.eml');
        expect(bob.index).toBe(1);
        // Alice (0) holds the kept copy of Bob (the dropped file, 1) and the kept copy of Carol.
        const carol = bySubject(out, 'carol subject');
        expect(holdsOf(given, 0)).toEqual([1, carol.index].sort((a, b) => a - b));
        expect(foldsFrom(out, bob, 0)).toBe(0);
        expect(bob.segments.filter((s) => !s.folded).map((s) => bob.message.bodyText.slice(s.start, s.end)).join('')).toContain(UNIQUE_A);
    });

    it('no attached email: the detector is given no `holds` key at all', async () =>
    {
        const { given } = spied([ok(await parseEml('one.eml', simple('bob', 'Mon, 2 Jun 2025 10:00:00 +0200', A_BODY))), ok(await parseEml('two.eml', simple('carol', null, B_BODY)))]);
        expect(given).toHaveLength(2);
        for (const input of given)
        {
            expect(input).not.toHaveProperty('holds');
        }
    });
});

// A plain dropped email for the contract test above (top level, no attached email).
const TOP_RESULT: ParseResult = {
    ok: true,
    message: {
        messageId: 'bob@example.test',
        inReplyTo: null,
        references: [],
        date: { utcMs: Date.parse('2025-06-02T08:00:00Z'), original: 'Mon, 2 Jun 2025 10:00:00 +0200', offsetMinutes: 120, zoneKnown: true },
        from: [{ name: 'bob', address: 'bob@example.test' }],
        to: [],
        cc: [],
        bcc: [],
        subject: 'bob subject',
        bodyText: A_BODY,
        attachments: [],
        source: { fileName: 'top.eml', sha256: 'a'.repeat(64), kind: 'eml' },
        warnings: [],
    },
};

describe('runEngine: attached emails and rebuilt emails', () =>
{
    it('a parent never yields a rebuilt copy of its own inline forward; a reply quoting the attached email links to it', async () =>
    {
        const aText = simple('bob', 'Mon, 2 Jun 2025 10:00:00 +0200', A_BODY);
        const parent = ok(await parseEml('parent.eml', holding('alice', 'Tue, 3 Jun 2025 14:00:00 +0200', plain('See below.'), rfc822(aText))));
        const reply = ok(
            await parseEml(
                'reply.eml',
                simple(
                    'carol',
                    'Wed, 4 Jun 2025 09:00:00 +0200',
                    ['Thanks, noted.', '', 'On Mon, 2 Jun 2025 at 10:00, bob <bob@example.test> wrote:', `> ${A_BODY}`, ''].join('\r\n'),
                    'In-Reply-To: <bob@example.test>',
                    'References: <bob@example.test>',
                ),
            ),
        );
        const out = runEngine([parent, reply]);
        expectWhole(out);
        const parentPosition = out.messages.findIndex((m) => m.message.subject === 'alice subject');
        const attachedPosition = out.messages.findIndex((m) => m.message.subject === 'bob subject');
        // Nothing is rebuilt inside the parent's forwarded block.
        const block = attachedAt(out, 2)!.places[0]!;
        for (const rebuilt of out.reconstructed)
        {
            if (out.positionByIndex[rebuilt.sourceIndex] !== parentPosition)
            {
                continue;
            }
            expect(rebuilt.rebuilt.end <= block.start || rebuilt.rebuilt.start >= block.end).toBe(true);
        }
        // The reply's quote of the attached email is linked to it ("the real file wins"): not its own entry.
        const fromReply = out.reconstructed.filter((r) => out.messages[out.positionByIndex[r.sourceIndex]!]?.message.subject === 'carol subject');
        expect(fromReply).toHaveLength(1);
        expect(fromReply[0]).toMatchObject({ link: 'real' });
        expect(out.positionByIndex[fromReply[0]!.realIndex!]).toBe(attachedPosition);
    });
});
