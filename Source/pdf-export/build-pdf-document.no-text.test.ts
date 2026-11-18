// The PDF document model and emails with no text (task 8.14; user decisions
// 2026-11-09 and 2026-11-15; Source/web-page-logic/no-printable-text.ts): an email whose body
// is only white space, and whose text was read, is left out of the PDF
// entirely, attachments or not, in both modes. No slot, no number (the
// others are numbered 1..k without a gap), no index entry, no bookmark, and
// it does not count on the cover (count, date range, people, undated). An
// unreadable body keeps the "(no text)" placeholder (Q2), and so does a
// forward whose forwarded emails print on pages of their own (Q6, see
// Source/pdf-export/build-pdf-document.no-repeat.test.ts). An attached email the reader ticked
// that is left out this way keeps its header lines in the email holding it;
// one the reader unticked is cut as before. An .eml with no text holding an
// email attached as a file that was not read is left out too (decision B).
// A rebuilt email with no text is left out too (Q4), its header lines
// staying where the plan puts them (folded as quoted history).
// Synthetic data only (README.md, rule R7).

import { beforeAll, describe, expect, it } from 'vitest';
import { readOutline, readPageRuns, readPdf, textLines } from '../../Helper/Test/test-support/pdf-reader';
import { attachedResult } from '../../Helper/Test/test-support/attached-builder';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { attachedLinks } from '../web-page-logic/attached-links';
import { hasNoPrintableText, pdfPositions } from '../web-page-logic/no-printable-text';
import { printedElsewhereRanges } from '../web-page-logic/printed-elsewhere';
import { rebuiltEntries } from '../web-page-logic/rebuilt-email-display';
import { generatePdf, type PdfFonts } from './generate-pdf';
import { loadPdfFonts } from './load-bundled-fonts';
import { buildPdfDocument, planPdfOrder } from './build-pdf-document';
import { createPdfStrings } from './pdf-strings';
import { lineText } from './pdf-text-transforms';
import type { OutputPolicy } from '../../Header/output-plan';
import type { NormalizedMessage, ParseResult, ParseWarning } from '../../Header/parsed-email';
import type { PdfDocument, PdfEmail } from '../../Header/pdf-document-model';
import type { EngineResult } from '../../Header/thread-analysis-result';

const EN = createPdfStrings('en');
const EVERYTHING: OutputPolicy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };
const POLICIES: readonly [string, OutputPolicy][] = [
    ['folded', DEFAULT_OUTPUT_POLICY],
    ['full text', EVERYTHING],
];
const BASE_MS = Date.UTC(2025, 3, 10, 9, 0, 0);

let counter = 0;
function make(subject: string, fields: Partial<NormalizedMessage> = {}): NormalizedMessage
{
    counter++;
    return {
        messageId: `no-text-${String(counter)}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: BASE_MS + counter * 86_400_000, original: 'synthetic', offsetMinutes: 60, zoneKnown: true },
        from: [{ name: 'Erin Sample', address: 'erin@example.test' }],
        to: [{ name: 'Finn Example', address: 'finn@example.test' }],
        cc: [],
        bcc: [],
        subject,
        bodyText: `Hello Finn,\n\nThis is note number ${String(counter)} about the ${subject.toLowerCase()} shelves.\n\nErin\n`,
        attachments: [],
        source: { fileName: `no-text-${String(counter)}.eml`, sha256: (0xc000 + counter).toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
        ...fields,
    };
}
const parsedOk = (message: NormalizedMessage): ParseResult => ({ ok: true, message });

function build(result: EngineResult, options: { positions?: readonly number[]; policy?: OutputPolicy; rebuilt?: readonly number[] } = {}): PdfDocument
{
    const positions = options.positions ?? result.messages.map((_, k) => k);
    const policy = options.policy ?? DEFAULT_OUTPUT_POLICY;
    return buildPdfDocument({
        result,
        positions,
        plans: planOutput(
            positions.map((p) => result.messages[p]!),
            policy,
        ),
        policy,
        timeZone: 'Africa/Lagos',
        generatedAt: Date.UTC(2025, 5, 1, 12, 0, 0),
        strings: EN,
        rebuilt: options.rebuilt ?? rebuiltEntries(result).map((r) => r.id),
    });
}

const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');
const positionOf = (result: EngineResult, subject: string): number => result.messages.findIndex((m) => m.message.subject === subject);

describe('emails with no text are left out of the PDF (task 8.14)', () =>
{
    // The empty email is the earliest one, the only undated one is empty too, and each has a person of its own:
    // the cover's date range, undated count and people would show them if they counted.
    const lonely = { name: 'Gail Lonely', address: 'gail@example.test' };
    const quiet = { name: 'Hank Quiet', address: 'hank@example.test' };
    const empty = make('Empty with attachment', {
        bodyText: '',
        date: { utcMs: BASE_MS - 30 * 86_400_000, original: 'synthetic', offsetMinutes: 60, zoneKnown: true },
        from: [lonely],
        attachments: [{ fileName: 'floor-plan.pdf', size: 12_345, mimeType: 'application/pdf' }],
    });
    const first = make('Oak');
    const blank = make('Only spaces', { bodyText: ' \t\n\n  \n﻿\n', from: [quiet], date: { utcMs: null, original: '', offsetMinutes: null, zoneKnown: false } });
    const last = make('Pine');
    const result = analyzeThread([empty, first, blank, last].map(parsedOk));

    for (const [mode, policy] of POLICIES)
    {
        it(`${mode}: no slot, no number, numbered 1..k, no index entry or bookmark, not on the cover`, () =>
        {
            const pdfDocument = build(result, { policy });
            const kept = [positionOf(result, 'Oak'), positionOf(result, 'Pine')];
            const gone = [positionOf(result, 'Empty with attachment'), positionOf(result, 'Only spaces')];
            expect(pdfDocument.emails.map((e) => e.position)).toEqual(kept);
            expect(pdfDocument.emails.map((e) => e.number)).toEqual([1, 2]);
            expect(pdfDocument.emails.map((e) => e.heading)).toEqual([EN.emailHeading(1), EN.emailHeading(2)]);
            for (const position of gone)
            {
                expect(pdfDocument.pdfNumberByPosition[position]).toBeNull();
            }
            expect(kept.map((p) => pdfDocument.pdfNumberByPosition[p])).toEqual([1, 2]);
            expect(pdfDocument.index.entries.map((e) => e.number)).toEqual([1, 2]);
            expect(pdfDocument.index.entries.map((e) => lineText(e.subject))).toEqual(['Oak', 'Pine']);
            const bookmarks = pdfDocument.index.entries.map((e) => e.bookmark).join('\n');
            for (const word of ['Empty with attachment', 'Only spaces', 'floor-plan.pdf'])
            {
                expect(bookmarks).not.toContain(word);
            }
            expect(pdfDocument.index.entries.flatMap((e) => e.attachmentLines.map(lineText)).join('\n')).not.toContain('floor-plan.pdf');
            // Cover (Q1): count, date range, undated and people of the emails in the PDF only.
            expect(pdfDocument.cover.emailCount).toBe(2);
            expect(pdfDocument.cover.undated).toBe(0);
            const oak = result.messages[kept[0]!]!.message.date.utcMs!;
            const pine = result.messages[kept[1]!]!.message.date.utcMs!;
            expect(pdfDocument.cover.dateRange).not.toBeNull();
            expect(pdfDocument.cover.dateRange!.first.slice(0, 10)).toBe(new Date(oak).toISOString().slice(0, 10));
            expect(pdfDocument.cover.dateRange!.last.slice(0, 10)).toBe(new Date(pine).toISOString().slice(0, 10));
            expect(pdfDocument.cover.participants.map((p) => p.address).sort()).toEqual(['erin@example.test', 'finn@example.test']);
            const cover = pdfDocument.cover.blocks.flatMap((b) =>
                (b.kind === 'fields' ? b.rows.flatMap((r) => r.value.map(lineText)) : b.kind === 'list' ? b.items.flat().map(lineText) : []));
            expect(cover).toContain(EN.emailCount(2));
            expect(cover.join('\n')).not.toMatch(/Gail|Hank/u);
        });
    }

    it('the order alone (planPdfOrder): the ticked emails less those with no text, numbered without a gap', () =>
    {
        const positions = result.messages.map((_, k) => k);
        const order = planPdfOrder(result, positions);
        expect(order.slots.map((s) => (s.kind === 'email' ? s.position : -1))).toEqual(pdfPositions(result, positions));
        expect(order.slots.map((s) => s.number)).toEqual([1, 2]);
        // The plan index still points at the right plan (the position's place in `positions`).
        for (const slot of order.slots)
        {
            if (slot.kind === 'email')
            {
                expect(positions[slot.plan]).toBe(slot.position);
            }
        }
    });

    it('keeps bodies that only look empty: a lone ">", U+200B, VT, FF, U+0000', () =>
    {
        for (const body of ['>', '​', '\u000b', '\u000c', '\u0000', ' > ', '\n\n>\n'])
        {
            const oddResult = analyzeThread([parsedOk(make('Odd', { bodyText: body }))]);
            expect(hasNoPrintableText(oddResult.messages[0]!.message), JSON.stringify(body)).toBe(false);
            for (const [, policy] of POLICIES)
            {
                expect(build(oddResult, { policy }).emails, JSON.stringify(body)).toHaveLength(1);
            }
        }
    });

    it('keeps an empty body whose text could not be read, with "(no text)" (Q2)', () =>
    {
        const warnings: readonly ParseWarning[] = ['html-body-unreadable', 'rtf-only-body', 'forwarded-message-not-expanded'];
        for (const warning of warnings)
        {
            const unreadResult = analyzeThread([parsedOk(make('Unread', { bodyText: '', warnings: ['no-body', warning] }))]);
            for (const [, policy] of POLICIES)
            {
                const pdfDocument = build(unreadResult, { policy });
                expect(pdfDocument.emails, warning).toHaveLength(1);
                expect(pdfDocument.emails[0]!.notes.map(lineText), warning).toEqual([EN.noText]);
                expect(pdfDocument.cover.emailCount).toBe(1);
            }
        }
    });

    it('every ticked email without text: a document with no email (generatePdf stays valid)', async () =>
    {
        const noTextResult = analyzeThread([parsedOk(make('A', { bodyText: '' })), parsedOk(make('B', { bodyText: '  \n' }))]);
        const pdfDocument = build(noTextResult);
        expect(pdfDocument.emails).toEqual([]);
        expect(pdfDocument.index.entries).toEqual([]);
        expect(pdfDocument.cover.emailCount).toBe(0);
        expect(pdfDocument.cover.dateRange).toBeNull();
        expect(pdfDocument.pdfNumberByPosition).toEqual([null, null]);
        const made = await generatePdf({
            result: noTextResult,
            positions: [0, 1],
            plans: planOutput(noTextResult.messages),
            policy: DEFAULT_OUTPUT_POLICY,
            timeZone: 'Africa/Lagos',
            generatedAt: Date.UTC(2025, 5, 1, 12, 0, 0),
            fonts,
            locale: 'en',
        });
        const pdf = readPdf(made.bytes);
        expect(made.pageCount).toBe(1);
        expect(readOutline(pdf)?.items.map((i) => i.title)).toEqual([EN.coverBookmark]);
        const text = (await readPageRuns(pdf)).map((runs) => textLines(runs).map((l) => l.shown).join(' ')).join(' ');
        expect(text).toContain(EN.emailCount(0));
    });

    let fonts: PdfFonts;
    beforeAll(async () =>
    {
        fonts = await loadPdfFonts();
    });
});

describe('attached emails with no text (task 8.14)', () =>
{
    const holderMessage = make('Holder');
    const child = make('Header only child', { bodyText: '' });
    const result = analyzeThread(
        [attachedResult({ message: holderMessage, children: [{ node: { message: child }, inline: true, name: 'fwd.eml' }] })]);
    const holder = positionOf(result, 'Holder');
    const attached = positionOf(result, 'Header only child');

    it('ticked by the reader: left out, its block (header lines) stays in the holder', () =>
    {
        expect(result.attached).toHaveLength(1);
        expect(hasNoPrintableText(result.messages[attached]!.message)).toBe(true);
        const pdfDocument = build(result);
        expect(pdfDocument.emails.map((e) => e.position)).toEqual([holder]);
        const body = bodyOf(pdfDocument.emails[0]!);
        expect(body).toContain('Subject: Header only child');
        expect(body).toContain('This is note number');
        // The preview's labels agree: nothing of the holder is left out.
        const ticked = result.messages.map((_, k) => k);
        const ranges = printedElsewhereRanges({ result, positions: ticked, plans: planOutput(ticked.map((p) => result.messages[p]!)), policy: DEFAULT_OUTPUT_POLICY, rebuilt: [] });
        expect(ranges.has(holder)).toBe(false);
    });

    it('unticked by the reader: its block is cut from the holder, as before (Q3 of task 8.13b-3)', () =>
    {
        const pdfDocument = build(result, { positions: [holder] });
        const body = bodyOf(pdfDocument.emails[0]!);
        expect(body).not.toContain('Subject: Header only child');
        expect(body).toContain('This is note number');
    });

    it('a holder with no text and an email attached as a file: the attached email is printed on its own', () =>
    {
        const emptyHolderResult = analyzeThread([
            attachedResult({ message: make('Empty holder', { bodyText: '' }), children: [{ node: { message: make('Attached item') }, inline: false, name: 'item.msg' }] }),
        ]);
        for (const [, policy] of POLICIES)
        {
            const pdfDocument = build(emptyHolderResult, { policy });
            expect(pdfDocument.emails.map((e) => lineText(e.fields.find((f) => f.label === EN.subjectLabel)!.value[0]!))).toEqual(['Attached item']);
            expect(pdfDocument.emails[0]!.number).toBe(1);
            expect(bodyOf(pdfDocument.emails[0]!)).toContain('This is note number');
        }
    });

    it('a holder with no text and an email attached as a FILE that was not read: left out (user decision B, 2026-11-15)', () =>
    {
        // The .eml parser lists such a part as a message/rfc822 attachment with no warning (task 8.13b-1); the
        // preview's note (attached-links.ts) says it was not read. Only an INLINE forward that was not read gives
        // 'forwarded-message-not-expanded' and stays in with "(no text)" (see the Q2 test above).
        const unreadFileResult = analyzeThread([
            parsedOk(make('Empty with unread file',
                { bodyText: '', warnings: ['no-body'], attachments: [{ fileName: 'lost-item.eml', size: 2_048, mimeType: 'message/rfc822' }] })),
            parsedOk(make('Walnut')),
        ]);
        const lost = positionOf(unreadFileResult, 'Empty with unread file');
        const walnut = positionOf(unreadFileResult, 'Walnut');
        expect(unreadFileResult.messages[lost]!.message.source.kind).toBe('eml');
        expect(hasNoPrintableText(unreadFileResult.messages[lost]!.message)).toBe(true);
        expect(attachedLinks(unreadFileResult).unread[lost]).toBe('attached-unread');
        const positions = unreadFileResult.messages.map((_, k) => k);
        expect(pdfPositions(unreadFileResult, positions)).toEqual([walnut]);
        for (const [mode, policy] of POLICIES)
        {
            const pdfDocument = build(unreadFileResult, { policy });
            expect(pdfDocument.emails.map((e) => e.position), mode).toEqual([walnut]);
            expect(pdfDocument.emails[0]!.number, mode).toBe(1);
            expect(pdfDocument.pdfNumberByPosition[lost], mode).toBeNull();
            expect(pdfDocument.cover.emailCount, mode).toBe(1);
            const indexText = pdfDocument.index.entries.flatMap((e) => [e.bookmark, ...e.attachmentLines.map(lineText)]).join('\n');
            expect(indexText, mode).not.toContain('lost-item.eml');
        }
    });
});

describe('rebuilt emails with no text (task 8.14, Q4)', () =>
{
    // A reply quoting two Outlook blocks: Bob's has nothing under its header, Carol's has a text.
    const OUTLOOK = (from: string, sent: string, to: string) =>
        `________________________________\nFrom: ${from}\nSent: ${sent}\nTo: ${to}\nSubject: Desks\n\n`;
    const body =
        'Thanks, see the history below.\n\n' +
        OUTLOOK('Bob Sample <bob@furniture.example.test>', 'Monday, March 3, 2025 2:02 PM', 'Alice Example <alice@example.test>') +
        '\n' +
        OUTLOOK('Carol Test <carol@sample.invalid>', 'Sunday, March 2, 2025 1:02 PM', 'Bob Sample <bob@furniture.example.test>') +
        'Old text from Carol about the twelve oak desks.\n';
    const result = analyzeThread([parsedOk(make('RE: Desks', { bodyText: body }))]);
    const entries = rebuiltEntries(result);
    const bob = entries.find((r) => r.rebuilt.from.some((m) => m.name === 'Bob Sample'));
    const carol = entries.find((r) => r.rebuilt.from.some((m) => m.name === 'Carol Test'));

    it('the header-only rebuilt email is left out; the source email prints exactly as with it not chosen', () =>
    {
        expect(bob).toBeDefined();
        expect(carol).toBeDefined();
        expect(bob!.rebuilt.reconstructedText.trim()).toBe('');
        const both = build(result, { rebuilt: [bob!.id, carol!.id] });
        const carolOnly = build(result, { rebuilt: [carol!.id] });
        expect(both.emails.map((e) => (e.rebuilt === null ? 'real' : e.rebuilt.id))).toEqual([carol!.id, 'real']);
        expect(both.emails.map((e) => e.number)).toEqual([1, 2]);
        // Bob's place stays in the source as its plan says (not cut as "printed as" a rebuilt email).
        expect(bodyOf(both.emails[1]!)).toBe(bodyOf(carolOnly.emails[1]!));
        expect(both.emails[1]!.flags.printedElsewhere).toBe(carolOnly.emails[1]!.flags.printedElsewhere);
        // Nothing printed nowhere: every word of text is in the PDF once.
        const all = both.emails.map(bodyOf).join('\n');
        expect(all).toContain('Thanks, see the history below.');
        expect(all.split('Old text from Carol about the twelve oak desks.')).toHaveLength(2);
        expect(both.cover.emailCount).toBe(2);
    });

    it('with the full text, no rebuilt email at all (as before)', () =>
    {
        const pdfDocument = build(result, { policy: EVERYTHING, rebuilt: [bob!.id, carol!.id] });
        expect(pdfDocument.emails.map((e) => e.position)).toEqual([0]);
        expect(bodyOf(pdfDocument.emails[0]!)).toContain('Subject: Desks');
    });
});
