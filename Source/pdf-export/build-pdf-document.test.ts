// Unit tests for the PDF document model (Source/pdf-export/build-pdf-document.ts), with synthetic
// emails (made-up names, *.test addresses) run through the real engine and
// output plan, as the app does.

import { describe, expect, it } from 'vitest';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { sizeText } from '../web-page/preview';
import { bookmarkTitle, buildPdfDocument, emailAnchor, MAX_BOOKMARK_LENGTH, participantsOf, pdfBodyText, pdfFileName,
    type BuildPdfInput } from './build-pdf-document';
import { createPdfStrings } from './pdf-strings';
import { lineText } from './pdf-text-transforms';
import { copyLayerText } from './pdf-writer/copy-layer-text';
import type { MessagePlan, OutputPolicy } from '../../Header/output-plan';
import type { EmailAddress, NormalizedMessage, ParseResult } from '../../Header/parsed-email';
import type { PdfDocument, PdfEmail, PdfLine } from '../../Header/pdf-document-model';
import type { EngineResult } from '../../Header/thread-analysis-result';

const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.test' };
const BOB: EmailAddress = { name: 'Bob Sample', address: 'bob@furniture.example.test' };
const CAROL: EmailAddress = { name: 'Carol Test', address: 'carol@sample.test' };
const strings = createPdfStrings('en');

/** 2025-03-04 08:00:00 UTC. */
const BASE_MS = Date.UTC(2025, 2, 4, 8, 0, 0);
let counter = 0;

function make(fields: Partial<NormalizedMessage> = {}): NormalizedMessage
{
    counter++;
    return {
        messageId: `pdf-model-${String(counter)}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: BASE_MS + counter * 3_600_000, original: 'Tue, 4 Mar 2025 09:00:00 +0100', offsetMinutes: 60, zoneKnown: true },
        from: [ALICE],
        to: [BOB],
        cc: [],
        bcc: [],
        subject: `Desks ${String(counter)}`,
        bodyText: `Hello Bob,\n\nThe desks arrive on Monday, note ${String(counter)}.\n\nAlice\n`,
        attachments: [],
        source: { fileName: `file-${String(counter)}.eml`, sha256: counter.toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
        ...fields,
    };
}

const parsedOk = (message: NormalizedMessage): ParseResult => ({ ok: true, message });
const undatedDate: NormalizedMessage['date'] = { utcMs: null, original: '', offsetMinutes: null, zoneKnown: false };

/** Runs the engine and the plans on every email (or the given positions), then builds the document. */
function build(
    results: readonly ParseResult[],
    options: { positions?: (r: EngineResult) => number[]; policy?: OutputPolicy; timeZone?: string; generatedAt?: number; plans?: (r: EngineResult, p: number[]) => MessagePlan[] } = {},
): { pdfDocument: PdfDocument; result: EngineResult; input: BuildPdfInput }
{
    const result = analyzeThread(results);
    const positions = options.positions?.(result) ?? result.messages.map((_, k) => k);
    const policy = options.policy ?? DEFAULT_OUTPUT_POLICY;
    const plans = options.plans?.(result, positions) ?? planOutput(positions.map((p) => result.messages[p]!), policy);
    const input: BuildPdfInput = {
        result,
        positions,
        plans,
        policy,
        timeZone: options.timeZone ?? 'UTC',
        generatedAt: options.generatedAt ?? Date.UTC(2025, 5, 1, 12, 0, 0),
        strings,
    };
    return { pdfDocument: buildPdfDocument(input), result, input };
}

const text = (line: PdfLine): string => lineText(line);
const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');
const field = (e: PdfEmail, label: string): readonly PdfLine[] | undefined => e.fields.find((f) => f.label === label)?.value;

describe('numbering and the index', () =>
{
    it('numbers only the included emails, 1..k in list order, and maps list positions to them', () =>
    {
        const msgs = [make(), make(), make(), make()];
        const { pdfDocument } = build(msgs.map(parsedOk), { positions: () => [0, 2, 3] });
        expect(pdfDocument.emails.map((e) => e.number)).toEqual([1, 2, 3]);
        expect(pdfDocument.emails.map((e) => e.position)).toEqual([0, 2, 3]);
        expect(pdfDocument.pdfNumberByPosition).toEqual([1, null, 2, 3]);
        expect(pdfDocument.emails.map((e) => e.heading)).toEqual(['Email 1', 'Email 2', 'Email 3']);
        expect(pdfDocument.index.entries.map((e) => [e.number, e.anchor])).toEqual([
            [1, 'email-1'],
            [2, 'email-2'],
            [3, 'email-3'],
        ]);
        expect(pdfDocument.emails.map((e) => e.anchor)).toEqual([emailAnchor(1), emailAnchor(2), emailAnchor(3)]);
        expect(pdfDocument.index.entries.map((e) => text(e.subject))).toEqual([msgs[0]!.subject, msgs[2]!.subject, msgs[3]!.subject]);
        expect(pdfDocument.cover.emailCount).toBe(3);
        expect(pdfDocument.index.heading).toBe('Index');
        expect(pdfDocument.index.columns.page).toBe('Page');
    });

    it('skips list positions that do not exist and repeated positions', () =>
    {
        const { pdfDocument } = build([make(), make()].map(parsedOk), {
            positions: () => [1, 7, 1, 0],
            plans: (r) => planOutput([r.messages[1]!, r.messages[0]!, r.messages[1]!, r.messages[0]!]),
        });
        expect(pdfDocument.emails.map((e) => e.position)).toEqual([1, 0]);
        expect(pdfDocument.pdfNumberByPosition).toEqual([2, 1]);
    });

    it('shows date, short author and subject in the index', () =>
    {
        const date = { utcMs: Date.UTC(2025, 2, 4, 9, 0, 0), original: 'x', offsetMinutes: 0, zoneKnown: true };
        const { pdfDocument } = build([make({ date, from: [ALICE, { name: '', address: 'dan@example.test' }] })].map(parsedOk),
            { timeZone: 'Africa/Lagos' });
        const entry = pdfDocument.index.entries[0]!;
        // Short in the index (no seconds, no offset); the column title names the zone once.
        expect(entry.date).toEqual([{ role: 'body', text: '2025-03-04 10:00' }]);
        expect(pdfDocument.index.columns.date).toBe('Date (Africa/Lagos)');
        expect(pdfDocument.index.columns.from).toBe('From');
        // The email's own header keeps the full form.
        expect(field(pdfDocument.emails[0]!, 'Date')!.map(text)[0]).toBe('2025-03-04 10:00:00 UTC+01:00');
        expect(text(entry.from)).toBe('Alice Example, dan@example.test');
        expect(entry.attachments).toBe(0);
    });

    it('names the zone in the index date column title as the cover does, UTC after a fallback', () =>
    {
        expect(build([parsedOk(make())], { timeZone: 'America/New_York' }).pdfDocument.index.columns.date).toBe('Date (America/New York)');
        expect(build([parsedOk(make())], { timeZone: 'UTC' }).pdfDocument.index.columns.date).toBe('Date (UTC)');
        expect(build([parsedOk(make())], { timeZone: 'Not/A_Zone' }).pdfDocument.index.columns.date).toBe('Date (UTC)');
    });

    it('gives an empty document for no included email', () =>
    {
        const { pdfDocument } = build([make()].map(parsedOk), { positions: () => [] });
        expect(pdfDocument.emails).toEqual([]);
        expect(pdfDocument.index.entries).toEqual([]);
        expect(pdfDocument.cover.dateRange).toBeNull();
        expect(pdfDocument.cover.participants).toEqual([]);
        expect(pdfDocument.pdfNumberByPosition).toEqual([null]);
    });
});

describe('header fields', () =>
{
    it('lists From, Sent by, To, Cc, Bcc when present, then Date, Subject and File', () =>
    {
        const message = make({
            sender: { name: 'Office Desk', address: 'desk@example.test' },
            to: [BOB, { name: '', address: '' }],
            cc: [CAROL],
            bcc: [{ name: '', address: 'archive@example.test' }],
        });
        const { pdfDocument } = build([parsedOk(message)]);
        const email = pdfDocument.emails[0]!;
        expect(email.fields.map((f) => f.label)).toEqual(['From', 'Sent by', 'To', 'Cc', 'Bcc', 'Date', 'Subject', 'File']);
        expect(text(field(email, 'From')![0]!)).toBe('Alice Example <alice@example.test>');
        expect(text(field(email, 'Sent by')![0]!)).toBe('Office Desk <desk@example.test>');
        expect(text(field(email, 'To')![0]!)).toBe('Bob Sample <bob@furniture.example.test>');
        expect(text(field(email, 'Bcc')![0]!)).toBe('archive@example.test');
        expect(text(field(email, 'File')![0]!)).toBe(message.source.fileName);
        expect(field(email, 'From')![0]![0]!.role).toBe('field-value');
    });

    it('joins several mailboxes with a plain ", " in English (unchanged) and in French (no "et"), header and index alike', () =>
    {
        const three = make({ from: [ALICE, BOB, CAROL], to: [ALICE, BOB, CAROL] });
        const fullLine = 'Alice Example <alice@example.test>, Bob Sample <bob@furniture.example.test>, Carol Test <carol@sample.test>';
        const indexLine = 'Alice Example, Bob Sample, Carol Test';
        const { pdfDocument, input } = build([parsedOk(three)]);
        const email = pdfDocument.emails[0]!;
        expect(text(field(email, 'From')![0]!)).toBe(fullLine);
        expect(text(field(email, 'To')![0]!)).toBe(fullLine);
        expect(text(pdfDocument.index.entries[0]!.from)).toBe(indexLine);

        const frenchStrings = createPdfStrings('fr');
        const frDoc = buildPdfDocument({ ...input, strings: frenchStrings });
        const frenchEmail = frDoc.emails[0]!;
        expect(text(field(frenchEmail, frenchStrings.fromLabel)![0]!)).toBe(fullLine);
        expect(text(field(frenchEmail, frenchStrings.toLabel)![0]!)).toBe(fullLine);
        expect(text(frDoc.index.entries[0]!.from)).toBe(indexLine);
    });

    it('leaves Cc and Bcc out when empty, and says "Unknown sender" without a From', () =>
    {
        const { pdfDocument } = build([parsedOk(make({ from: [], to: [] }))]);
        const email = pdfDocument.emails[0]!;
        expect(email.fields.map((f) => f.label)).toEqual(['From', 'Date', 'Subject', 'File']);
        expect(field(email, 'From')![0]).toEqual([{ role: 'muted', text: 'Unknown sender' }]);
        expect(text(pdfDocument.index.entries[0]!.from)).toBe('Unknown sender');
    });

    it('shows the date in the chosen zone, with the sender local time when it differs', () =>
    {
        const message = make(
            { date: { utcMs: Date.UTC(2025, 2, 4, 8, 0, 0), original: 'Tue, 4 Mar 2025 09:00:00 +0100', offsetMinutes: 60, zoneKnown: true } });
        const tokyo = build([parsedOk(message)], { timeZone: 'Asia/Tokyo' }).pdfDocument.emails[0]!;
        expect(field(tokyo, 'Date')!.map(text)).toEqual(['2025-03-04 17:00:00 UTC+09:00', "Sender's local time: 2025-03-04 09:00:00 UTC+01:00"]);
        // A zone at the sender's own offset (+01:00 all year): one line only.
        const lagos = build([parsedOk(message)], { timeZone: 'Africa/Lagos' }).pdfDocument.emails[0]!;
        expect(field(lagos, 'Date')!.map(text)).toEqual(['2025-03-04 09:00:00 UTC+01:00']);
    });

    it('flags an unknown sender time zone, but writes no note about it (task 8.8: the app says it)', () =>
    {
        const message = make({
            date: { utcMs: BASE_MS, original: 'Tue, 4 Mar 2025 08:00:00', offsetMinutes: null, zoneKnown: false },
            warnings: ['unknown-time-zone'],
        });
        const email = build([parsedOk(message)]).pdfDocument.emails[0]!;
        expect(field(email, 'Date')!.map(text)).toEqual(['2025-03-04 08:00:00 UTC+00:00']);
        expect(email.flags.zoneUnknown).toBe(true);
        expect(email.notes).toEqual([]);
    });

    it('shows "(no subject)" for an empty or blank subject, in header and index', () =>
    {
        const { pdfDocument } = build([parsedOk(make({ subject: '' })), parsedOk(make({ subject: '   ' }))]);
        for (const [k, email] of pdfDocument.emails.entries())
        {
            expect(field(email, 'Subject')![0]).toEqual([{ role: 'muted', text: '(no subject)' }]);
            expect(pdfDocument.index.entries[k]!.subject).toEqual([{ role: 'muted', text: '(no subject)' }]);
        }
    });

    it('puts a subject with line breaks and control characters on one line, codes in their own role', () =>
    {
        const { pdfDocument } = build([parsedOk(make({ subject: 'Re: desks\r\n\u0007 now' }))]);
        expect(field(pdfDocument.emails[0]!, 'Subject')![0]).toEqual([
            { role: 'field-value', text: 'Re: desks ' },
            { role: 'code', text: '[U+0007]' },
            { role: 'field-value', text: ' now' },
        ]);
        // The index shows the subject too, but each replaced character is counted once.
        expect(pdfDocument.emails[0]!.flags.controlChars).toBe(1);
        expect(pdfDocument.controlChars).toBe(1);
    });
});

describe('undated emails', () =>
{
    it('shows an unreadable date as written, "(no date)" without one, and keeps them out of the date range (no note, task 8.8)', () =>
    {
        const dated = make({ date: { utcMs: Date.UTC(2025, 2, 1, 9, 0, 0), original: 'x', offsetMinutes: 0, zoneKnown: true } });
        const later = make({ date: { utcMs: Date.UTC(2025, 3, 2, 9, 0, 0), original: 'x', offsetMinutes: 0, zoneKnown: true } });
        const bad = make({ date: { utcMs: null, original: 'Someday, around noon', offsetMinutes: null, zoneKnown: false }, warnings: ['unparseable-date'] });
        const none = make({ date: undatedDate, warnings: ['missing-date'] });
        const { pdfDocument } = build([bad, later, none, dated].map(parsedOk));
        const [first, second, third, fourth] = pdfDocument.emails;
        expect([first, second, third, fourth].map((e) => e!.flags.undated)).toEqual([false, false, true, true]);
        expect(field(third!, 'Date')).toEqual([[{ role: 'field-value', text: 'Someday, around noon' }]]);
        expect(field(fourth!, 'Date')).toEqual([[{ role: 'muted', text: '(no date)' }]]);
        expect(pdfDocument.index.entries[2]!.date).toEqual([{ role: 'muted', text: '(no date)' }]);
        expect(third!.notes).toEqual([]);
        expect(pdfDocument.cover.dateRange).toEqual({ first: '2025-03-01 09:00:00 UTC+00:00', last: '2025-04-02 09:00:00 UTC+00:00' });
        // Counted in the data, not written on the cover.
        expect(pdfDocument.cover.undated).toBe(2);
        expect(coverRow(pdfDocument, 'Dates').map(text)).toEqual(['2025-03-01 09:00:00 UTC+00:00 to 2025-04-02 09:00:00 UTC+00:00']);
    });

    it('writes an unreadable date with control characters as codes, counted', () =>
    {
        const bad = make({ date: { utcMs: null, original: 'Mon\u0007day', offsetMinutes: null, zoneKnown: false }, warnings: ['unparseable-date'] });
        const { pdfDocument } = build([parsedOk(bad)]);
        expect(field(pdfDocument.emails[0]!, 'Date')).toEqual([
            [
                { role: 'field-value', text: 'Mon' },
                { role: 'code', text: '[U+0007]' },
                { role: 'field-value', text: 'day' },
            ],
        ]);
        expect(pdfDocument.controlChars).toBe(1);
    });

    it('shows the "(no date)" placeholder on the cover when no email has a date', () =>
    {
        const { pdfDocument } = build([parsedOk(make({ date: undatedDate })), parsedOk(make({ date: undatedDate }))]);
        expect(pdfDocument.cover.dateRange).toBeNull();
        expect(pdfDocument.cover.undated).toBe(2);
        expect(coverRow(pdfDocument, 'Dates')).toEqual([[{ role: 'muted', text: '(no date)' }]]);
    });
});

function coverRow(pdfDocument: PdfDocument, label: string): readonly PdfLine[]
{
    for (const block of pdfDocument.cover.blocks)
    {
        if (block.kind !== 'fields')
        {
            continue;
        }
        const row = block.rows.find((r) => r.label === label);
        if (row !== undefined)
        {
            return row.value;
        }
    }
    throw new Error(`no cover row ${label}`);
}

describe('cover', () =>
{
    it('gives the date range in the chosen zone (first and last may change day)', () =>
    {
        const earlyMessage = make({ date: { utcMs: Date.UTC(2025, 2, 1, 23, 30, 0), original: 'x', offsetMinutes: 0, zoneKnown: true } });
        const lateMessage = make({ date: { utcMs: Date.UTC(2025, 2, 9, 2, 15, 0), original: 'x', offsetMinutes: 0, zoneKnown: true } });
        const utc = build([earlyMessage, lateMessage].map(parsedOk), { timeZone: 'UTC' }).pdfDocument.cover.dateRange;
        const tokyo = build([earlyMessage, lateMessage].map(parsedOk), { timeZone: 'Asia/Tokyo' }).pdfDocument.cover.dateRange;
        const newYorkRange = build([earlyMessage, lateMessage].map(parsedOk), { timeZone: 'America/New_York' }).pdfDocument.cover.dateRange;
        expect(utc).toEqual({ first: '2025-03-01 23:30:00 UTC+00:00', last: '2025-03-09 02:15:00 UTC+00:00' });
        expect(tokyo).toEqual({ first: '2025-03-02 08:30:00 UTC+09:00', last: '2025-03-09 11:15:00 UTC+09:00' });
        // 2025-03-09 is the US switch to summer time (at 07:00 UTC): both dates still in winter time.
        expect(newYorkRange).toEqual({ first: '2025-03-01 18:30:00 UTC-05:00', last: '2025-03-08 21:15:00 UTC-05:00' });
    });

    it('shows one date when every email has the same moment', () =>
    {
        const message = make({ date: { utcMs: BASE_MS, original: 'x', offsetMinutes: 0, zoneKnown: true } });
        const { pdfDocument } = build([parsedOk(message)]);
        expect(coverRow(pdfDocument, 'Dates').map(text)).toEqual(['2025-03-04 08:00:00 UTC+00:00']);
    });

    it('has the title, count, zone and generation date', () =>
    {
        const { pdfDocument } = build([make(), make()].map(parsedOk), { timeZone: 'America/New_York', generatedAt: Date.UTC(2025, 5, 1, 3, 0, 0) });
        const first = pdfDocument.cover.blocks[0]!;
        expect(first).toEqual({ kind: 'heading', level: 1, line: [{ role: 'title', text: 'Email correspondence' }] });
        expect(pdfDocument.title).toBe('Email correspondence');
        expect(coverRow(pdfDocument, 'Emails').map(text)).toEqual(['2 emails']);
        expect(coverRow(pdfDocument, 'Dates shown in').map(text)).toEqual(['America/New York']);
        expect(coverRow(pdfDocument, 'Made on').map(text)).toEqual(['2025-05-31 23:00:00 UTC-04:00']);
        expect(pdfDocument.cover.generated).toBe('2025-05-31 23:00:00 UTC-04:00');
        expect(pdfDocument.timeZone).toBe('America/New_York');
        expect(pdfDocument.zoneFallback).toBe(false);
        expect(
            build([parsedOk(make())]).pdfDocument.cover.blocks.some((b) => b.kind === 'paragraph' && text(b.line).includes('control'))).toBe(false);
    });

    it('falls back to UTC for an unknown zone, and names just UTC (task 8.8: the app says the zone was not recognized)', () =>
    {
        const { pdfDocument } = build([parsedOk(make())], { timeZone: 'Not/AZone' });
        expect(pdfDocument.timeZone).toBe('UTC');
        expect(pdfDocument.zoneFallback).toBe(true);
        expect(coverRow(pdfDocument, 'Dates shown in').map(text)).toEqual(['UTC']);
        expect(pdfDocument.fileName).toBe('correspondence-2025-06-01.pdf');
    });

    it('lists distinct people from From, Sender, To and Cc of the included emails only, sorted, by address ignoring case', () =>
    {
        const msgs = [
            make({ from: [{ name: '', address: 'ALICE@Example.TEST' }], to: [BOB], cc: [{ name: 'carol', address: 'carol@sample.test' }] }),
            make({ from: [ALICE], to: [{ name: 'Bobby', address: 'bob@FURNITURE.example.test' }], sender: { name: 'Front Desk', address: 'desk@example.test' } }),
            make({ from: [{ name: 'Zed Excluded', address: 'zed@example.test' }] }),
            make({ from: [CAROL], to: [{ name: 'No Address Person', address: '' }, { name: '', address: '' }], bcc: [{ name: 'Hidden', address: 'hidden@example.test' }] }),
        ];
        const { pdfDocument } = build(msgs.map(parsedOk),
            { positions: (r) => r.messages.flatMap((m, k) => (m.message.from[0]?.name === 'Zed Excluded' ? [] : [k])) });
        expect(pdfDocument.cover.participants).toEqual([
            // The name comes from the second Alice mailbox, so its spelling of the address does too.
            { name: 'Alice Example', address: 'alice@example.test' },
            { name: 'Bob Sample', address: 'bob@furniture.example.test' },
            { name: 'carol', address: 'carol@sample.test' },
            { name: 'Front Desk', address: 'desk@example.test' },
            { name: 'No Address Person', address: '' },
        ]);
        const list = pdfDocument.cover.blocks.find((b) => b.kind === 'list');
        expect(list?.kind === 'list' ? list.items.map((item) => item.map(text)) : null).toEqual([
            ['Alice Example <alice@example.test>'],
            ['Bob Sample <bob@furniture.example.test>'],
            ['carol <carol@sample.test>'],
            ['Front Desk <desk@example.test>'],
            ['No Address Person'],
        ]);
    });

    it('participantsOf merges name-only people by name, ignoring case', () =>
    {
        const message = make({ from: [{ name: 'Dana', address: '' }], to: [{ name: 'DANA', address: '' }] });
        expect(participantsOf([message], 'en')).toEqual([{ name: 'Dana', address: '' }]);
    });

    it('participantsOf never combines a name from one mailbox with the address spelling of another', () =>
    {
        const message = make({
            from: [{ name: '', address: 'ERIN@EXAMPLE.TEST' }],
            to: [{ name: 'Erin Sample', address: 'erin@example.test' }],
            cc: [{ name: 'E. Sample', address: 'Erin@Example.Test' }],
        });
        // The first mailbox with a name gives both name and spelling; later ones change nothing.
        expect(participantsOf([message], 'en')).toEqual([{ name: 'Erin Sample', address: 'erin@example.test' }]);
        // Without any name, the first spelling seen stays.
        const nameless = make({ from: [{ name: '', address: 'Finn@Example.TEST' }], to: [{ name: '', address: 'finn@example.test' }] });
        expect(participantsOf([nameless], 'en')).toEqual([{ name: '', address: 'Finn@Example.TEST' }]);
    });

    it('has no source file list and no hash on the cover (task 8.12); each email names its files, merged copies too', () =>
    {
        const original = make({ messageId: 'same@example.test' });
        const copy = { ...original, source: { fileName: 'copy-of-it.msg', sha256: 'c'.repeat(64), kind: 'msg' as const } };
        const other = make();
        const excluded = make();
        const failed: ParseResult = { ok: false, fileName: 'broken.eml', sha256: 'f'.repeat(64), error: 'corrupt', detail: 'synthetic' };
        const tooBig: ParseResult = { ok: false, fileName: 'huge.eml', sha256: null, error: 'too-large', detail: 'synthetic' };
        const { pdfDocument, result } = build([parsedOk(original), failed, parsedOk(other), parsedOk(copy), parsedOk(excluded), tooBig], {
            positions: (r) => r.messages.flatMap((m, k) => (m.message === excluded ? [] : [k])),
        });
        expect(result.counts.duplicatesMerged).toBe(1);
        expect(Object.keys(pdfDocument.cover)).not.toContain('sources');
        // The cover: title, summary, people; one list (the people), no source files heading.
        expect(pdfDocument.cover.blocks.filter((b) => b.kind === 'list')).toHaveLength(1);
        const headings = pdfDocument.cover.blocks.filter((b) => b.kind === 'heading').map((b) => (b.kind === 'heading' ? text(b.line) : ''));
        expect(headings).toEqual(['Email correspondence', 'People']);
        expect(pdfDocument.cover.blocks.some((b) => b.kind === 'paragraph')).toBe(false);
        // No file name and no hash on the cover, read or not.
        const coverText = JSON.stringify(pdfDocument.cover.blocks);
        for (const name of [original.source.fileName, 'copy-of-it.msg', other.source.fileName, 'broken.eml', 'huge.eml'])
        {
            expect(coverText, name).not.toContain(name);
        }
        expect(coverText).not.toMatch(/[0-9a-f]{64}/);
        // Collapse, never delete: each email header still names its files, the merged copy included.
        expect(field(pdfDocument.emails[0]!, 'File')!.map(text)).toEqual([original.source.fileName, 'copy-of-it.msg']);
        expect(field(pdfDocument.emails[1]!, 'File')!.map(text)).toEqual([other.source.fileName]);
    });

    it('gives a nameless file a visible text', () =>
    {
        const message = make({ source: { fileName: '', sha256: 'a'.repeat(64), kind: 'eml' } });
        const { pdfDocument } = build([parsedOk(message)]);
        expect(field(pdfDocument.emails[0]!, 'File')).toEqual([[{ role: 'muted', text: '(file without a name)' }]]);
    });
});

describe('body', () =>
{
    const question = make({
        from: [BOB],
        to: [ALICE],
        subject: 'Delivery',
        bodyText: 'Hello Alice,\n\nCan the desks be delivered on Monday morning before ten?\nThe office opens at eight.\n\nBob\n',
    });
    const reply = make({
        from: [ALICE],
        to: [BOB],
        subject: 'Re: Delivery',
        inReplyTo: question.messageId,
        references: [question.messageId!],
        bodyText:
            'Yes, Monday morning works.\n\nAlice\n\nOn Tue, 4 Mar 2025 at 09:00, Bob Sample <bob@furniture.example.test> wrote:\n> Hello Alice,\n>\n> Can the desks be delivered on Monday morning before ten?\n> The office opens at eight.\n>\n> Bob\n',
    });

    it('shows the kept ranges only: the quoted history of a reply is left out', () =>
    {
        const { pdfDocument } = build([question, reply].map(parsedOk));
        const body = bodyOf(pdfDocument.emails[1]!);
        expect(body).toBe('Yes, Monday morning works.\n\nAlice');
        expect(pdfDocument.emails[1]!.notes).toEqual([]);
    });

    /** The whole reply as the PDF shows it (tasks 8.1 and 8.6): its ">" marks removed. */
    const replyShown = reply.bodyText.trimEnd().replace(/^> ?/gmu, '');

    it('shows the whole body with unfoldEverything, whatever the plans say, without the quote marks', () =>
    {
        const policy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };
        const { pdfDocument } = build([question, reply].map(parsedOk), { policy, plans: (r, p) => planOutput(p.map((k) => r.messages[k]!)) });
        expect(bodyOf(pdfDocument.emails[1]!)).toBe(replyShown);
        expect(replyShown).toContain('wrote:\nHello Alice,\n\nCan the desks');
        expect(reply.bodyText.split('\n').filter((l) => l.startsWith('>'))).toHaveLength(6);
    });

    it('keeps the whole body, with no note (task 8.8), when the plan is missing or invalid', () =>
    {
        const cases: ((r: EngineResult) => MessagePlan[])[] = [
            () => [],
            (r) => [{ ...planOutput([r.messages[0]!])[0]!, ranges: [{ start: 0, end: 3, keep: true, reason: 'text' }] }], // a gap
            (r) => [{ ...planOutput([r.messages[0]!])[0]!, ranges: [{ start: 0, end: 99_999, keep: true, reason: 'text' }] }],
            (r) => [{ ...planOutput([r.messages[0]!])[0]!, fallback: true }],
            () => [null as unknown as MessagePlan],
        ];
        for (const plans of cases)
        {
            const { pdfDocument } = build([parsedOk(reply)], { plans });
            const email = pdfDocument.emails[0]!;
            expect(bodyOf(email)).toBe(replyShown);
            expect(email.flags.planFallback).toBe(true);
            expect(email.notes).toEqual([]);
        }
    });

    it('flags a body kept whole because nothing else would remain, with no note (task 8.8)', () =>
    {
        const { pdfDocument } = build([parsedOk(reply)], {
            plans: (r) => [{ ...planOutput([r.messages[0]!])[0]!, keptAllBecauseEmpty: true }],
        });
        expect(pdfDocument.emails[0]!.flags.keptAllBecauseEmpty).toBe(true);
        expect(pdfDocument.emails[0]!.notes).toEqual([]);
    });

    it('pdfBodyText adds a line break only where two kept parts would run together', () =>
    {
        const body = 'abc>skipdef';
        const plan: MessagePlan = {
            ranges: [
                { start: 0, end: 3, keep: true, reason: 'text' },
                { start: 3, end: 8, keep: false, reason: 'repeated-signature' },
                { start: 8, end: 11, keep: true, reason: 'forwarded' },
            ],
            tailStart: null,
            omittedSignatures: 1,
            keptAllBecauseEmpty: false,
            fallback: false,
        };
        // "def" began inside a line of the body: its offset (4) is not a line start for the quote prefixes (task 8.1).
        expect(pdfBodyText(body, plan, DEFAULT_OUTPUT_POLICY)).toEqual({ text: 'abc\ndef', planFallback: false, notLineStarts: new Set([4]) });
        expect(pdfBodyText(body, plan, { unfoldEverything: true })).toEqual({ text: body, planFallback: false, notLineStarts: new Set() });
    });

    it('pdfBodyText keeps the whole body when the ranges have a gap, overlap or go past the end', () =>
    {
        const body = 'abcdefghij'; // 10 code units
        const plan = (ranges: { start: number; end: number; keep: boolean }[]): MessagePlan => ({
            ranges: ranges.map((r) => ({ ...r, reason: 'text' as const })),
            tailStart: null,
            omittedSignatures: 0,
            keptAllBecauseEmpty: false,
            fallback: false,
        });
        const whole = { text: body, planFallback: true, notLineStarts: new Set() };
        // A gap: [0, 3) then [5, 10) would silently drop "de".
        expect(pdfBodyText(body, plan([{ start: 0, end: 3, keep: true }, { start: 5, end: 10, keep: true }]), DEFAULT_OUTPUT_POLICY)).toEqual(whole);
        // An overlap: [0, 5) then [3, 10) would show "de" twice.
        expect(pdfBodyText(body, plan([{ start: 0, end: 5, keep: true }, { start: 3, end: 10, keep: true }]), DEFAULT_OUTPUT_POLICY)).toEqual(whole);
        // Past the end.
        expect(pdfBodyText(body, plan([{ start: 0, end: 3, keep: true }, { start: 3, end: 12, keep: true }]), DEFAULT_OUTPUT_POLICY)).toEqual(whole);
        // An empty range, a range not reaching the end, no range for a non-empty body, a bad `keep`.
        expect(pdfBodyText(body, plan([{ start: 0, end: 0, keep: true }, { start: 0, end: 10, keep: true }]), DEFAULT_OUTPUT_POLICY)).toEqual(whole);
        expect(pdfBodyText(body, plan([{ start: 0, end: 9, keep: true }]), DEFAULT_OUTPUT_POLICY)).toEqual(whole);
        expect(pdfBodyText(body, plan([]), DEFAULT_OUTPUT_POLICY)).toEqual(whole);
        expect(pdfBodyText(body, plan([{ start: 0, end: 10, keep: 'yes' as unknown as boolean }]), DEFAULT_OUTPUT_POLICY)).toEqual(whole);
        // A plan that is null or missing: the whole body, never a TypeError.
        expect(pdfBodyText(body, null, DEFAULT_OUTPUT_POLICY)).toEqual(whole);
        expect(pdfBodyText(body, undefined, DEFAULT_OUTPUT_POLICY)).toEqual(whole);
        // The same ranges, valid: used as they are.
        expect(pdfBodyText(body, plan([{ start: 0, end: 3, keep: true }, { start: 3, end: 10, keep: false }]), DEFAULT_OUTPUT_POLICY)).toEqual({ text: 'abc', planFallback: false, notLineStarts: new Set() });
        expect(pdfBodyText('', plan([]), DEFAULT_OUTPUT_POLICY)).toEqual({ text: '', planFallback: false, notLineStarts: new Set() });
    });

    it('applies the display transforms and counts control characters', () =>
    {
        const message = make({ bodyText: '\n\nLine\u0000one\tend\r\n\r\n\r\n\r\n\r\nLine two\uD800\n\n\n' });
        const { pdfDocument } = build([parsedOk(make()), parsedOk(message)], { policy: { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true } });
        const email = pdfDocument.emails.find((x) => field(x, 'File')?.[0] !== undefined && text(field(x, 'File')![0]!) === message.source.fileName)!;
        expect(bodyOf(email)).toBe('Line[U+0000]one    end\n\n\nLine two[U+D800]');
        expect(email.body[0]).toEqual([
            { role: 'body', text: 'Line' },
            { role: 'code', text: '[U+0000]' },
            { role: 'body', text: 'one    end' },
        ]);
        expect(email.flags.controlChars).toBe(2);
        expect(pdfDocument.controlChars).toBe(2);
        // Counted in the data; the cover has no note about it (task 8.8: the app says it).
        expect(pdfDocument.cover.blocks.some((b) => b.kind === 'paragraph')).toBe(false);
    });

    it('says "(no text)" for an empty body whose text could not be read (task 8.14: one with no text at all is left out)', () =>
    {
        const { pdfDocument } = build([parsedOk(make({ bodyText: '', warnings: ['no-body', 'rtf-only-body'] }))]);
        expect(pdfDocument.emails[0]!.body).toEqual([]);
        expect(pdfDocument.emails[0]!.notes.map(text)).toEqual(['(no text)']);
    });

    it('writes no note about content the reader cannot see in full (task 8.8: the app says it)', () =>
    {
        const warnings = ['html-converted-body', 'html-body-truncated', 'html-body-unreadable', 'rtf-only-body', 'forwarded-message-not-expanded'] as const;
        const { pdfDocument } = build([parsedOk(make({ warnings: [...warnings] }))]);
        const email = pdfDocument.emails[0]!;
        expect(email.flags.htmlConverted).toBe(true);
        expect(email.notes).toEqual([]);
    });
});

describe('attachments', () =>
{
    it('lists name, size and type, or nothing', () =>
    {
        const message = make({
            attachments: [
                { fileName: 'quote.pdf', size: 12_345, mimeType: 'application/pdf' },
                { fileName: '', size: null, mimeType: '' },
                { fileName: 'plan\u0000.png', size: 512, mimeType: 'image/png' },
            ],
        });
        const { pdfDocument } = build([parsedOk(message), parsedOk(make())]);
        const attachments = pdfDocument.emails[0]!.attachments!;
        expect(attachments.label).toBe('Attachments');
        expect(attachments.items.map(text)).toEqual(
            ['quote.pdf (12 KB, application/pdf)', '(attachment without a name) (size unknown)', 'plan[U+0000].png (512 bytes, image/png)']);
        expect(attachments.items[0]![0]).toEqual({ role: 'field-value', text: 'quote.pdf' });
        expect(pdfDocument.index.entries[0]!.attachments).toBe(3);
        // The index lists the same lines (not counted twice as control characters).
        expect(pdfDocument.index.entries[0]!.attachmentLines).toBe(attachments.items);
        expect(pdfDocument.index.entries[1]!.attachmentLines).toEqual([]);
        expect(pdfDocument.emails[1]!.attachments).toBeNull();
        expect(pdfDocument.emails[0]!.flags.controlChars).toBe(1);
    });

    it('writes sizes as the preview does', () =>
    {
        for (const size of [0, 1, 1023, 1024, 1500, 10_239, 10_240, 1_048_575, 1_048_576, 5_500_000, null, -1, Number.NaN])
        {
            expect(strings.size(size), String(size)).toBe(sizeText(size));
        }
    });
});

describe('pdfFileName', () =>
{
    it('uses the generation date in the chosen zone', () =>
    {
        const lateUtc = Date.UTC(2025, 2, 1, 23, 30, 0); // 2025-03-01 23:30 UTC
        expect(pdfFileName(lateUtc, 'UTC', strings)).toBe('correspondence-2025-03-01.pdf');
        expect(pdfFileName(lateUtc, 'Africa/Lagos', strings)).toBe('correspondence-2025-03-02.pdf'); // 00:30 the next day at +01:00
        expect(pdfFileName(lateUtc - 3_600_000, 'Africa/Lagos', strings)).toBe('correspondence-2025-03-01.pdf'); // 23:30 at +01:00
        expect(pdfFileName(lateUtc, 'America/New_York', strings)).toBe('correspondence-2025-03-01.pdf');
        const earlyUtc = Date.UTC(2025, 2, 2, 0, 30, 0); // 2025-03-02 00:30 UTC
        expect(pdfFileName(earlyUtc, 'UTC', strings)).toBe('correspondence-2025-03-02.pdf');
        expect(pdfFileName(earlyUtc, 'America/Los_Angeles', strings)).toBe('correspondence-2025-03-01.pdf');
        expect(pdfFileName(earlyUtc, 'Pacific/Kiritimati', strings)).toBe('correspondence-2025-03-02.pdf');
        expect(pdfFileName(Date.UTC(2024, 11, 31, 11, 0, 0), 'Pacific/Kiritimati', strings)).toBe('correspondence-2025-01-01.pdf');
    });

    it('falls back to UTC for an unknown zone and to a plain name without a usable moment', () =>
    {
        expect(pdfFileName(Date.UTC(2025, 2, 1, 23, 30, 0), 'Not/AZone', strings)).toBe('correspondence-2025-03-01.pdf');
        expect(pdfFileName(Number.NaN, 'UTC', strings)).toBe('correspondence.pdf');
    });

    it('is the document file name', () =>
    {
        const { pdfDocument } = build([parsedOk(make())], { generatedAt: Date.UTC(2025, 2, 1, 23, 30, 0), timeZone: 'Asia/Tokyo' });
        expect(pdfDocument.fileName).toBe('correspondence-2025-03-02.pdf');
    });
});

describe('purity', () =>
{
    /** Freezes an object and everything in it. */
    function deepFreeze<T>(value: T): T
    {
        if (typeof value === 'object' && value !== null && !Object.isFrozen(value))
        {
            Object.freeze(value);
            for (const child of Object.values(value))
            {
                deepFreeze(child);
            }
        }
        return value;
    }

    it('never changes the result, the plans or the messages, and gives the same document twice', () =>
    {
        const msgs = [make({ bodyText: 'a\tb\r\nc\u0000\n\n\n\nd' }), make({ attachments: [{ fileName: 'x.txt', size: 3, mimeType: 'text/plain' }] })];
        const result = analyzeThread(msgs.map(parsedOk));
        const plans = planOutput(result.messages);
        const before = JSON.stringify({ result, plans });
        deepFreeze(result);
        deepFreeze(plans);
        const input: BuildPdfInput = { result, positions: [0, 1], plans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'America/New_York', generatedAt: BASE_MS, strings };
        const first = buildPdfDocument(input);
        const second = buildPdfDocument(input);
        expect(JSON.stringify({ result, plans })).toBe(before);
        expect(second).toEqual(first);
        // Plain data: survives a structured clone unchanged (no functions, no classes).
        expect(structuredClone(first)).toEqual(first);
    });
});

describe('bookmarks', () =>
{
    it('gives each email a one-line bookmark: number, day in the zone, sender, subject', () =>
    {
        const { pdfDocument } = build(
            [
                parsedOk(make({ subject: 'Desks\r\nfor the\toffice \u0007' })),
                parsedOk(make({ subject: '', from: [], date: undatedDate })),
                parsedOk(make({ subject: 'y'.repeat(200), from: [CAROL] })),
            ],
            { timeZone: 'Asia/Tokyo' },
        );
        const [first, second, third] = pdfDocument.index.entries.map((e) => e.bookmark);
        // The day as shown in the chosen zone (the first 10 characters of the email's date there).
        expect(first).toBe(`1. ${lineText(pdfDocument.index.entries[0]!.date).slice(0, 10)}, Alice Example: Desks for the    office [U+0007]`);
        expect(first).toMatch(/^1\. \d{4}-\d{2}-\d{2}, /);
        expect(third).toBe('3. (no date), Unknown sender: (no subject)');
        expect(Array.from(second!)).toHaveLength(MAX_BOOKMARK_LENGTH);
        expect(second!.startsWith(`2. ${lineText(pdfDocument.index.entries[1]!.date).slice(0, 10)}, Carol Test: yyy`)).toBe(true);
        expect(second!.endsWith('y\u{2026}')).toBe(true);
    });

    it('gives the day in the CHOSEN zone: 02:00 UTC is still the day before in New York', () =>
    {
        const date = { utcMs: Date.UTC(2025, 5, 2, 2, 0, 0), original: 'Mon, 2 Jun 2025 02:00:00 +0000', offsetMinutes: 0, zoneKnown: true };
        const message = make({ date, subject: 'Chairs' });
        expect(build([parsedOk(message)], { timeZone: 'America/New_York' }).pdfDocument.index.entries[0]!.bookmark)
            .toBe('1. 2025-06-01, Alice Example: Chairs');
        expect(build([parsedOk(message)], { timeZone: 'UTC' }).pdfDocument.index.entries[0]!.bookmark).toBe('1. 2025-06-02, Alice Example: Chairs');
    });

    // The text before the part that crosses the cut: `pad` characters, so that part sits on code point MAX_BOOKMARK_LENGTH - 1.
    const across = (pad: number, part: string): string => 'a'.repeat(pad) + part + 'b'.repeat(20);
    const keep = MAX_BOOKMARK_LENGTH - 1; // code points kept before the cut mark, at most

    it('never cuts inside a kept flag: the whole flag goes (no tag characters left behind)', () =>
    {
        const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'; // 7 code points
        const title = bookmarkTitle(across(keep - 4, england));
        expect(title).toBe('a'.repeat(keep - 4) + '\u{2026}');
        expect(copyLayerText(title)).toBe(title); // nothing for the copy layer to replace
        // A flag that ends exactly at the cut is kept whole.
        expect(bookmarkTitle(across(keep - 7, england))).toBe('a'.repeat(keep - 7) + england + '\u{2026}');
    });

    it('never cuts inside a ZWJ emoji chain: the family goes whole, not as a smaller family', () =>
    {
        const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}'; // 7 code points
        // The cut falls before the last ZWJ: "man, woman, girl" would be another emoji.
        expect(bookmarkTitle(across(keep - 5, family))).toBe('a'.repeat(keep - 5) + '\u{2026}');
        expect(bookmarkTitle(across(keep - 7, family))).toBe('a'.repeat(keep - 7) + family + '\u{2026}');
        // A skin tone stays with its hand.
        expect(bookmarkTitle(across(keep - 1, '\u{1F44B}\u{1F3FD}'))).toBe('a'.repeat(keep - 1) + '\u{2026}');
    });

    it('never splits a regional-indicator pair (a country flag)', () =>
    {
        const japan = '\u{1F1EF}\u{1F1F5}';
        expect(bookmarkTitle(across(keep - 1, japan))).toBe('a'.repeat(keep - 1) + '\u{2026}');
        expect(bookmarkTitle(across(keep - 2, japan))).toBe('a'.repeat(keep - 2) + japan + '\u{2026}');
        // Pairs count from the start of the run: the third indicator starts a new pair.
        expect(bookmarkTitle(across(keep - 3, japan + japan))).toBe('a'.repeat(keep - 3) + japan + '\u{2026}');
    });

    it('never separates a letter from its combining accents', () =>
    {
        expect(bookmarkTitle(across(keep - 1, 'e\u{301}'))).toBe('a'.repeat(keep - 1) + '\u{2026}');
        expect(bookmarkTitle(across(keep - 2, 'e\u{301}\u{323}'))).toBe('a'.repeat(keep - 2) + '\u{2026}');
        expect(bookmarkTitle(across(keep - 2, 'e\u{301}'))).toBe('a'.repeat(keep - 2) + 'e\u{301}\u{2026}');
        // A variation selector stays with its character too.
        expect(bookmarkTitle(across(keep - 1, '\u{2764}\u{FE0F}'))).toBe('a'.repeat(keep - 1) + '\u{2026}');
        // Spaces before what was dropped go as well.
        expect(bookmarkTitle(across(keep - 2, ' e\u{301}'))).toBe('a'.repeat(keep - 2) + '\u{2026}');
    });

    it('cuts a title to MAX_BOOKMARK_LENGTH code points, never inside a surrogate pair', () =>
    {
        expect(bookmarkTitle('short')).toBe('short');
        const exact = 'a'.repeat(MAX_BOOKMARK_LENGTH);
        expect(bookmarkTitle(exact)).toBe(exact);
        const emoji = '\u{1F600}'.repeat(MAX_BOOKMARK_LENGTH + 5);
        const cut = bookmarkTitle(emoji);
        expect(Array.from(cut)).toHaveLength(MAX_BOOKMARK_LENGTH);
        expect(cut).toBe('\u{1F600}'.repeat(MAX_BOOKMARK_LENGTH - 1) + '\u{2026}');
        // Spaces before the cut mark are dropped.
        expect(bookmarkTitle('a'.repeat(MAX_BOOKMARK_LENGTH - 3) + '   tail')).toBe('a'.repeat(MAX_BOOKMARK_LENGTH - 3) + '\u{2026}');
    });
});
