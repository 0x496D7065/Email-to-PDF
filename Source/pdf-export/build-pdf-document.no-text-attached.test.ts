// User decision Q5, 2026-11-21 (rule F2 of task 9.9b for attached emails): an email attached inside a
// dropped file that has no text (task 8.14: no page, no index entry, no bookmark) and NO attachments
// puts nothing in the default PDF either: its printed block in the email holding it (the attached-email
// separator line and its header lines) is printed nowhere, whether the reader ticked it or not, with
// rebuilding on (rebuilt emails ticked or unticked) or off. The preview labels the block "Not in the
// PDF: email #N (attached here) has no text" ('no-text-attached'; 'unticked-attached' when the reader
// unticked it). User decision 2026-11-22: one with no text but WITH attachments (a phone forward of a
// PDF, say) keeps its block in the holder while the reader ticks it, so the PDF still says who sent the
// files and when; the preview labels nothing of it as left out. Its attachments stay listed in the
// holder's list either way. An attached email with text is printed as before, and "Print full original
// text" prints every body whole, as before.
// Real parsers (.eml: message/rfc822 parts; .msg: attached Outlook items) on synthetic files built in
// memory (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { buildMsg, type MsgSpec } from '../../Helper/Test/test-data/msg/builder';
import { referenceDisplayText } from '../../Helper/Test/test-support/reference-pdf-text-transforms';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { createEmlParser } from '../email-reading/eml-parser';
import { FORWARDED_SEPARATOR } from '../email-reading/forwarded-block';
import type { HtmlToTextResult } from '../email-reading/html-to-text';
import { createMsgParser } from '../email-reading/msg-parser';
import { readPageRuns, readPdf, textLines } from '../../Helper/Test/test-support/pdf-reader';
import { hasNoPrintableText } from '../web-page-logic/no-printable-text';
import { pdfBlocks, printedAsEmailOfItsOwn } from '../web-page-logic/pdf-plan';
import { printedElsewhereRanges, type PrintedElsewhereInput } from '../web-page-logic/printed-elsewhere';
import { rebuiltEntries } from '../web-page-logic/rebuilt-email-display';
import { applyNoRepeatRule, buildPdfDocument, pdfRanges } from './build-pdf-document';
import { generatePdf } from './generate-pdf';
import { loadPdfFonts } from './load-bundled-fonts';
import { createPdfStrings } from './pdf-strings';
import { lineText } from './pdf-text-transforms';
import type { MessagePlan, OutputPolicy } from '../../Header/output-plan';
import type { ParseResult } from '../../Header/parsed-email';
import type { PdfDocument, PdfEmail } from '../../Header/pdf-document-model';
import type { ThreadAnalysisResult } from '../../Header/thread-analysis-result';

const EN = createPdfStrings('en');
const FULL: OutputPolicy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };
const stub = (html: string): HtmlToTextResult => ({ text: `[html ${String(html.length)}]`, truncated: false });
const emlParser = createEmlParser({ htmlToText: stub });
const msgParser = createMsgParser({ htmlToText: stub });

const crlf = (...lines: string[]): string => lines.join('\r\n');
const plain = (text: string): string => crlf('Content-Type: text/plain; charset=utf-8', '', text);
const mixed = (boundary: string, ...parts: string[]): string =>
    crlf(`Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts.flatMap((p) => [`--${boundary}`, p]), `--${boundary}--`, '');
const rfc822 = (message: string, disposition?: string): string =>
    crlf('Content-Type: message/rfc822', ...(disposition === undefined ? [] : [`Content-Disposition: ${disposition}`]), '', message);
const pdfPart = (fileName: string): string =>
    crlf(`Content-Type: application/pdf; name="${fileName}"`, `Content-Disposition: attachment; filename="${fileName}"`, 'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQK');
const head = (name: string, date: string): string[] => [
    `From: ${name} <${name}@example.test>`,
    'To: Team <team@example.test>',
    `Date: ${date}`,
    `Subject: ${name} subject`,
    `Message-ID: <${name}.no-text-attached@example.test>`,
    'MIME-Version: 1.0',
];
const simple = (name: string, date: string, body: string): string => crlf(...head(name, date), '', body);
const holding = (name: string, date: string, ...parts: string[]): string => crlf(...head(name, date), mixed(`b-${name}`, ...parts));

const OWN = 'Please find the forwarded order below, as promised during the call on Monday.';
const B_BODY = 'The twelve oak desks are ready for delivery on Friday, the movers have the address.';
const MON = 'Mon, 2 Jun 2025 10:00:00 +0200';
const TUE = 'Tue, 3 Jun 2025 14:00:00 +0200';
const WED = 'Wed, 4 Jun 2025 09:00:00 +0200';

async function parseEml(name: string, text: string): Promise<ParseResult>
{
    const parsed = await emlParser.parse({ name, bytes: new TextEncoder().encode(text) });
    if (!parsed.ok)
    {
        throw new Error(parsed.detail);
    }
    return parsed;
}

/** The default modes of the PDF (rebuilt emails ticked, unticked, rebuilding off). */
const MODES = [
    { name: 'every rebuilt email ticked', rebuilt: (ids: readonly number[]) => [...ids], unticked: () => [] as number[], off: false },
    { name: 'every rebuilt email unticked', rebuilt: () => [] as number[], unticked: (ids: readonly number[]) => [...ids], off: false },
    { name: 'rebuilding off', rebuilt: () => [] as number[], unticked: () => [] as number[], off: true },
] as const;
type Mode = (typeof MODES)[number];

interface Made
{
    readonly result: ThreadAnalysisResult;
    readonly positions: readonly number[];
    readonly plans: readonly MessagePlan[];
    readonly input: PrintedElsewhereInput;
    readonly pdf: PdfDocument;
}

/** The PDF of `result` with the emails at `positions` ticked (default: all). */
function make(result: ThreadAnalysisResult, mode: Mode, policy: OutputPolicy = DEFAULT_OUTPUT_POLICY,
    positions: readonly number[] = result.messages.map((_, k) => k)): Made
{
    const plans = planOutput(positions.map((p) => result.messages[p]!), policy);
    const ids = rebuiltEntries(result).map((r) => r.id);
    const input: PrintedElsewhereInput = { result, positions, plans, policy, rebuilt: mode.rebuilt(ids), unticked: mode.unticked(ids), rebuildingOff: mode.off };
    const pdf = buildPdfDocument({ ...input, generatedOffsetMinutes: 0, generatedAt: Date.UTC(2025, 5, 10, 12, 0, 0), strings: EN });
    return { result, positions, plans, input, pdf };
}

const squash = (s: string): string => s.replace(/\s+/gu, ' ').trim();
const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');
/** Every text of the PDF's emails and index (header rows, notes, body, attachments), squashed. */
const allText = (pdf: PdfDocument): string => squash([
    ...pdf.emails.map((e) => [
        e.heading,
        ...e.fields.map((f) => f.value.map(lineText).join(' ')),
        ...e.notes.map(lineText),
        bodyOf(e),
        ...(e.attachments?.items.map(lineText) ?? []),
    ].join('\n')),
    ...pdf.index.entries.map((e) => [e.bookmark, ...e.attachmentLines.map(lineText)].join('\n')),
].join('\n'));
const positionOf = (result: ThreadAnalysisResult, subject: string): number => result.messages.findIndex((m) => m.message.subject === subject);
const emailOf = (made: Made, subject: string): PdfEmail | undefined =>
    made.pdf.emails.find((e) => e.position !== null && made.result.messages[e.position]?.message.subject === subject);

/** Per character of the body at list position `position`: whether the PDF prints it (default policy). */
function printedChars(made: Made, position: number): Uint8Array
{
    const { result, plans, input } = made;
    const body = result.messages[position]!.message.bodyText;
    const plan = plans[made.positions.indexOf(position)]!;
    const { parts, restored } = applyNoRepeatRule(input);
    const ranges = pdfRanges(body, plan, DEFAULT_OUTPUT_POLICY, parts.get(position) ?? [], restored.get(position)) ?? plan.ranges;
    const printed = new Uint8Array(body.length);
    for (const range of ranges)
    {
        if (range.keep)
        {
            printed.fill(1, range.start, range.end);
        }
    }
    return printed;
}

/**
 * AC 1 and 4 on one PDF: every attached email with no text is not in the PDF (no page, no index entry),
 * and not one non-blank character of its block is printed in any email holding it; the preview labels
 * the block "out", as 'no-text-attached' (or 'unticked-attached' when the reader unticked it), and its
 * blocks give the body back whole. Returns how many blocks in an email of the PDF were checked.
 */
function expectNoAttachedBlocks(made: Made, where: string): number
{
    const { result, pdf } = made;
    let checked = 0;
    for (const attached of result.attached ?? [])
    {
        const position = result.positionByIndex[attached.index]!;
        if (!hasNoPrintableText(result.messages[position]!.message))
        {
            continue;
        }
        expect(pdf.pdfNumberByPosition[position] ?? null, where).toBeNull();
        expect(pdf.emails.some((e) => e.position === position), where).toBe(false);
        expect(pdf.index.entries).toHaveLength(pdf.emails.length);
        for (const place of attached.places)
        {
            const holder = result.positionByIndex[place.holderIndex]!;
            if (!pdf.emails.some((e) => e.position === holder))
            {
                continue;
            }
            const body = result.messages[holder]!.message.bodyText;
            expect(body.slice(place.start).startsWith(FORWARDED_SEPARATOR), where).toBe(true);
            const printed = printedChars(made, holder);
            for (let i = place.start; i < place.end; i++)
            {
                expect(printed[i] === 1 && /\S/u.test(body[i]!), `${where}: "${squash(body.slice(place.start, place.end))}" printed at ${String(i)}`).toBe(false);
            }
            const ranges = (printedElsewhereRanges(made.input).get(holder) ?? []).filter((r) => r.printedAs !== null
                && r.start < place.end && place.start < r.end && /\S/u.test(body.slice(Math.max(r.start, place.start), Math.min(r.end, place.end))));
            expect(ranges.length, `${where}: labelled`).toBeGreaterThan(0);
            const readerTicked = made.positions.includes(position);
            for (const range of ranges)
            {
                expect(range.printedAs, where).toEqual({ kind: readerTicked ? 'no-text-attached' : 'unticked-attached', position });
            }
            const plan = made.plans[made.positions.indexOf(holder)]!;
            const view = { plan, signatureFrom: new Map<number, number>(), pdfRanges: printedElsewhereRanges(made.input).get(holder)! };
            // Printed nowhere, so not "printed as an email of its own" (the note of an email kept whole, task 8.11).
            expect(printedAsEmailOfItsOwn({ pdfRanges: ranges }, body), where).toBe(false);
            const blocks = pdfBlocks(body, result.messages[holder]!.segments, view);
            expect(blocks.map((b) => b.block.text).join(''), where).toBe(body);
            for (const { label } of blocks.filter((b) => b.block.start < place.end && place.start < b.block.end && /\S/u.test(b.block.text)))
            {
                expect(label?.status, where).toBe('out');
            }
            checked++;
        }
    }
    return checked;
}

/**
 * User decision 2026-11-22: every attached email with no text but WITH attachments that the reader ticked
 * keeps its whole block in every email of the PDF holding it: every non-blank character of it printed,
 * nothing of it labelled as left out in the preview. Returns how many blocks in an email of the PDF were checked.
 */
function expectKeptAttachedBlocks(made: Made, where: string): number
{
    const { result, pdf } = made;
    let checked = 0;
    for (const attached of result.attached ?? [])
    {
        const position = result.positionByIndex[attached.index]!;
        const message = result.messages[position]!.message;
        if (!hasNoPrintableText(message) || message.attachments.length === 0 || !made.positions.includes(position))
        {
            continue;
        }
        expect(pdf.pdfNumberByPosition[position] ?? null, where).toBeNull();
        for (const place of attached.places)
        {
            const holder = result.positionByIndex[place.holderIndex]!;
            if (!pdf.emails.some((e) => e.position === holder))
            {
                continue;
            }
            const body = result.messages[holder]!.message.bodyText;
            expect(body.slice(place.start).startsWith(FORWARDED_SEPARATOR), where).toBe(true);
            const labelled = (printedElsewhereRanges(made.input).get(holder) ?? []).filter((r) => r.printedAs !== null
                && r.start < place.end && place.start < r.end);
            if (labelled.length > 0)
            {
                // Nested in the block of another email attached here: printed on that email's own page (kind
                // 'email'), or cut with it when the reader unticked it (Q3). Never left out on its own account.
                for (const range of labelled)
                {
                    const printedAs = range.printedAs!;
                    const enclosing = printedAs.kind === 'email' || (printedAs.kind === 'unticked-attached' && printedAs.position !== position);
                    expect(enclosing, `${where}: ${JSON.stringify(printedAs)}`).toBe(true);
                }
                checked++;
                continue;
            }
            const printed = printedChars(made, holder);
            for (let i = place.start; i < place.end; i++)
            {
                expect(printed[i] === 1 || !/\S/u.test(body[i]!), `${where}: "${squash(body.slice(place.start, place.end))}" not printed at ${String(i)}`).toBe(true);
            }
            const plan = made.plans[made.positions.indexOf(holder)]!;
            const view = { plan, signatureFrom: new Map<number, number>(), pdfRanges: printedElsewhereRanges(made.input).get(holder) ?? [] };
            for (const { label } of pdfBlocks(body, result.messages[holder]!.segments, view)
                .filter((b) => b.block.start < place.end && place.start < b.block.end && /\S/u.test(b.block.text)))
            {
                expect(label?.status ?? 'in', where).not.toBe('out');
            }
            checked++;
        }
    }
    return checked;
}

/** "Print full original text": every email in the PDF whole, as before (AC 5). */
function expectFullTextWhole(result: ThreadAnalysisResult, where: string): PdfDocument
{
    const made = make(result, MODES[0], FULL);
    for (const email of made.pdf.emails)
    {
        expect(bodyOf(email), where).toBe(referenceDisplayText(result.messages[email.position!]!.message.bodyText));
    }
    expect(applyNoRepeatRule(made.input).parts.size, where).toBe(0);
    expect(printedElsewhereRanges(made.input).size, where).toBe(0);
    return made.pdf;
}

describe('an attached email with no text and no attachments: its block is printed nowhere in the PDF (Q5)', () =>
{
    const headerOnly = async (): Promise<ThreadAnalysisResult> =>
        analyzeThread([await parseEml('holder.eml', holding('alice', TUE, plain(OWN), rfc822(simple('bob', MON, ''))))]);
    const blankBody = async (): Promise<ThreadAnalysisResult> =>
        analyzeThread([await parseEml('holder.eml', holding('alice', TUE, plain(OWN), rfc822(simple('bob', MON, ' \r\n\t\r\n\r\n   '))))]);

    for (const [what, build] of [['header lines only', headerOnly], ['blank text only', blankBody]] as const)
    {
        it(`.eml, ${what}: in every default mode, ticked or unticked, no separator or header line of it in the PDF`, async () =>
        {
            const result = await build();
            const holder = positionOf(result, 'alice subject');
            const attached = positionOf(result, 'bob subject');
            expect(result.attached).toHaveLength(1);
            expect(result.attached![0]!.places).toHaveLength(1);
            expect(hasNoPrintableText(result.messages[attached]!.message)).toBe(true);
            expect(result.messages[attached]!.message.attachments).toEqual([]);
            const body = result.messages[holder]!.message.bodyText;
            expect(body).toContain(FORWARDED_SEPARATOR);
            expect(body).toContain('Subject: bob subject');
            let checked = 0;
            for (const mode of MODES)
            {
                for (const positions of [[holder, attached], [holder]])
                {
                    const made = make(result, mode, DEFAULT_OUTPUT_POLICY, positions);
                    const where = `${what}, ${mode.name}, ticked ${positions.join(',')}`;
                    checked += expectNoAttachedBlocks(made, where);
                    expect(made.pdf.emails.map((e) => e.position), where).toEqual([holder]);
                    expect(made.pdf.emails[0]!.number, where).toBe(1);
                    expect(made.pdf.cover.emailCount, where).toBe(1);
                    expect(squash(bodyOf(made.pdf.emails[0]!)), where).toBe(squash(OWN));
                    const text = allText(made.pdf);
                    expect(text, where).not.toContain(FORWARDED_SEPARATOR.trim());
                    expect(text, where).not.toContain('bob subject');
                    expect(text, where).not.toContain('bob@example.test');
                }
            }
            expect(checked).toBe(6);
        });
    }

    it('.eml, sent as a file (no block): left out, still listed as an attachment of the holder (AC 2)', async () =>
    {
        const result = analyzeThread([await parseEml('holder.eml',
            holding('alice', TUE, plain(OWN), rfc822(simple('bob', MON, ''), 'attachment; filename="empty-note.eml"')))]);
        const attached = positionOf(result, 'bob subject');
        expect(result.attached![0]!.places).toEqual([]);
        expect(hasNoPrintableText(result.messages[attached]!.message)).toBe(true);
        for (const mode of MODES)
        {
            const made = make(result, mode);
            expect(made.pdf.emails.map((e) => e.position), mode.name).toEqual([positionOf(result, 'alice subject')]);
            expect(squash(bodyOf(made.pdf.emails[0]!)), mode.name).toBe(squash(OWN));
            expect(made.pdf.emails[0]!.attachments?.items.map(lineText).join('\n'), mode.name).toContain('empty-note.eml');
        }
    });

    it('.eml, an attached email WITH text: unchanged, its block printed as it on its own page (AC 3)', async () =>
    {
        const result = analyzeThread([await parseEml('holder.eml', holding('alice', TUE, plain(OWN), rfc822(simple('bob', MON, B_BODY))))]);
        const attached = positionOf(result, 'bob subject');
        for (const mode of MODES)
        {
            const made = make(result, mode);
            expect(made.pdf.emails).toHaveLength(2);
            expect(squash(bodyOf(emailOf(made, 'alice subject')!)), mode.name).toBe(squash(OWN));
            const page = emailOf(made, 'bob subject')!;
            expect(squash(bodyOf(page)), mode.name).toContain(squash(B_BODY));
            const kinds = (printedElsewhereRanges(made.input).get(positionOf(result, 'alice subject')) ?? []).map((r) => r.printedAs?.kind ?? null);
            expect(kinds.filter((k) => k !== null), mode.name).toEqual(['email']);
            const holderBody = result.messages[positionOf(result, 'alice subject')]!.message.bodyText;
            expect(printedAsEmailOfItsOwn({ pdfRanges: printedElsewhereRanges(made.input).get(positionOf(result, 'alice subject'))! }, holderBody), mode.name).toBe(true);
            // Unticked: left out with it, as before (Q3).
            const unticked = make(result, mode, DEFAULT_OUTPUT_POLICY, [positionOf(result, 'alice subject')]);
            expect(allText(unticked.pdf), mode.name).not.toContain(squash(B_BODY));
            expect((printedElsewhereRanges(unticked.input).get(positionOf(result, 'alice subject')) ?? []).filter((r) => r.printedAs !== null)
                .map((r) => r.printedAs), mode.name).toEqual([{ kind: 'unticked-attached', position: attached }]);
        }
    });

    it('.eml, nested: an email with no text inside an attached email with text, printed nowhere at either level', async () =>
    {
        const carol = rfc822(simple('carol', MON, ''));
        const bob = rfc822(holding('bob', TUE, plain(B_BODY), carol));
        const result = analyzeThread([await parseEml('holder.eml', holding('alice', WED, plain(OWN), bob))]);
        const alice = positionOf(result, 'alice subject');
        const bobAt = positionOf(result, 'bob subject');
        const carolAt = positionOf(result, 'carol subject');
        const carolEntry = result.attached!.find((a) => result.positionByIndex[a.index] === carolAt)!;
        // Its block is printed inside bob's text and, through bob's block, inside alice's text.
        expect(carolEntry.places.map((p) => result.positionByIndex[p.holderIndex]).sort()).toEqual([alice, bobAt].sort());
        expect(hasNoPrintableText(result.messages[carolAt]!.message)).toBe(true);
        let checked = 0;
        for (const mode of MODES)
        {
            for (const positions of [[alice, bobAt, carolAt], [alice, bobAt], [alice, carolAt], [bobAt, carolAt]])
            {
                const made = make(result, mode, DEFAULT_OUTPUT_POLICY, positions);
                const where = `nested, ${mode.name}, ticked ${positions.join(',')}`;
                checked += expectNoAttachedBlocks(made, where);
                const text = allText(made.pdf);
                expect(text, where).not.toContain('carol subject');
                expect(text, where).not.toContain('carol@example.test');
                // Bob's text: printed once while bob is ticked, nowhere when he is not (Q3).
                expect(text.split(squash(B_BODY)).length - 1, where).toBe(positions.includes(bobAt) ? 1 : 0);
            }
        }
        // carol's block in bob (when bob is in the PDF) and in alice (when alice is): 2 + 2 + 1 + 1 per mode.
        expect(checked).toBe(3 * (2 + 2 + 1 + 1));
    });

    it('.msg: an attached Outlook item with no text: left out, still listed; the holder prints its own text only', async () =>
    {
        const item: MsgSpec = {
            id: 'empty-item',
            description: 'empty item',
            strings: 'unicode',
            subject: 'Empty item',
            sender: { name: 'Bob Sample', smtp: 'bob@example.test' },
            recipients: [{ type: 'to', name: 'Team', smtp: 'team@example.test' }],
            bodyText: '  \n\n',
            submitTime: '2025-06-02T08:00:00Z',
            messageId: '<empty-item@example.test>',
        };
        const outer: MsgSpec = { ...item, id: 'outer', subject: 'Outer item', sender: { name: 'Alice Example', smtp: 'alice@example.test' }, bodyText: OWN,
            submitTime: '2025-06-03T08:00:00Z', messageId: '<outer-item@example.test>', attachedItems: [{ displayName: 'Empty item', message: item }] };
        const result = analyzeThread([await msgParser.parse({ name: 'outer.msg', bytes: buildMsg(outer) })]);
        const itemAt = positionOf(result, 'Empty item');
        expect(itemAt).toBeGreaterThanOrEqual(0);
        expect(hasNoPrintableText(result.messages[itemAt]!.message)).toBe(true);
        for (const mode of MODES)
        {
            const made = make(result, mode);
            expect(expectNoAttachedBlocks(made, mode.name)).toBe(0);
            expect(made.pdf.emails.map((e) => e.position), mode.name).toEqual([positionOf(result, 'Outer item')]);
            expect(squash(bodyOf(made.pdf.emails[0]!)), mode.name).toBe(squash(OWN));
            const text = allText(made.pdf);
            expect(text, mode.name).toContain('Empty item.msg');
            expect(text, mode.name).not.toContain('Subject: Empty item');
        }
    });

    it('"Print full original text": unchanged, every body whole with the attached email\'s separator and header lines (AC 5)', async () =>
    {
        for (const build of [headerOnly, blankBody])
        {
            const result = await build();
            const pdf = expectFullTextWhole(result, 'full text');
            expect(pdf.emails.map((e) => e.position)).toEqual([positionOf(result, 'alice subject')]);
            expect(bodyOf(pdf.emails[0]!)).toContain(FORWARDED_SEPARATOR);
            expect(bodyOf(pdf.emails[0]!)).toContain('Subject: bob subject');
        }
        const nested = analyzeThread([await parseEml('holder.eml',
            holding('alice', WED, plain(OWN), rfc822(holding('bob', TUE, plain(B_BODY), rfc822(holding('carol', MON, pdfPart('carol-plan.pdf')))))))]);
        const pdf = expectFullTextWhole(nested, 'nested, full text');
        expect(pdf.emails).toHaveLength(2);
        expect(pdf.emails.every((e) => bodyOf(e).includes('Subject: carol subject'))).toBe(true);
    });
});

describe('an attached email with no text but WITH attachments: its block stays in the holder (user decision 2026-11-22)', () =>
{
    // A phone forward of a file: no text, only the header lines and the attachment.
    const headerOnly = async (): Promise<ThreadAnalysisResult> =>
        analyzeThread([await parseEml('holder.eml', holding('alice', TUE, plain(OWN), rfc822(holding('bob', MON, pdfPart('floor-plan.pdf')))))]);
    const blankBody = async (): Promise<ThreadAnalysisResult> =>
        analyzeThread([await parseEml('holder.eml', holding('alice', TUE, plain(OWN), rfc822(holding('bob', MON, plain(' \r\n\t\r\n'), pdfPart('floor-plan.pdf')))))]);

    for (const [what, build] of [['header lines only', headerOnly], ['blank text', blankBody]] as const)
    {
        it(`.eml, ${what} and an attachment, ticked: its separator and header lines printed in the holder, the attachment listed`, async () =>
        {
            const result = await build();
            const holder = positionOf(result, 'alice subject');
            const attached = positionOf(result, 'bob subject');
            expect(result.attached).toHaveLength(1);
            expect(result.attached![0]!.places).toHaveLength(1);
            const message = result.messages[attached]!.message;
            expect(hasNoPrintableText(message)).toBe(true);
            expect(message.attachments.map((a) => a.fileName)).toEqual(['floor-plan.pdf']);
            let checked = 0;
            for (const mode of MODES)
            {
                const made = make(result, mode);
                const where = `${what}, ${mode.name}`;
                checked += expectKeptAttachedBlocks(made, where);
                // Still no page of its own (task 8.14).
                expect(made.pdf.emails.map((e) => e.position), where).toEqual([holder]);
                expect(made.pdf.cover.emailCount, where).toBe(1);
                const page = bodyOf(made.pdf.emails[0]!);
                expect(page, where).toContain(FORWARDED_SEPARATOR.trim());
                expect(page, where).toContain('Subject: bob subject');
                expect(page, where).toContain('bob@example.test');
                expect(squash(page), where).toContain(squash(OWN));
                // The attachment: in the holder's list and index entry.
                expect(made.pdf.emails[0]!.attachments?.items.map(lineText).join('\n'), where).toContain('floor-plan.pdf');
                expect(made.pdf.index.entries[0]!.attachments, where).toBe(1);
                expect(made.pdf.index.entries[0]!.attachmentLines.map(lineText).join('\n'), where).toContain('floor-plan.pdf');
                // No "Not in the PDF" label anywhere in the holder.
                expect((printedElsewhereRanges(made.input).get(holder) ?? []).filter((r) => r.printedAs !== null), where).toEqual([]);
            }
            expect(checked).toBe(3);
        });

        it(`.eml, ${what} and an attachment, unticked by the reader: cut as before (Q3), the attachment still listed`, async () =>
        {
            const result = await build();
            const holder = positionOf(result, 'alice subject');
            const attached = positionOf(result, 'bob subject');
            for (const mode of MODES)
            {
                const made = make(result, mode, DEFAULT_OUTPUT_POLICY, [holder]);
                const where = `${what}, ${mode.name}`;
                expect(expectNoAttachedBlocks(made, where), where).toBe(1);
                expect((printedElsewhereRanges(made.input).get(holder) ?? []).filter((r) => r.printedAs !== null).map((r) => r.printedAs), where)
                    .toEqual([{ kind: 'unticked-attached', position: attached }]);
                const text = allText(made.pdf);
                expect(text, where).not.toContain('bob subject');
                expect(made.pdf.emails[0]!.attachments?.items.map(lineText).join('\n'), where).toContain('floor-plan.pdf');
            }
        });
    }

    it('.eml, nested: an email with no text and an attachment inside an attached email with text: its header lines printed once', async () =>
    {
        const carol = rfc822(holding('carol', MON, pdfPart('carol-plan.pdf')));
        const bob = rfc822(holding('bob', TUE, plain(B_BODY), carol));
        const result = analyzeThread([await parseEml('holder.eml', holding('alice', WED, plain(OWN), bob))]);
        const alice = positionOf(result, 'alice subject');
        const bobAt = positionOf(result, 'bob subject');
        const carolAt = positionOf(result, 'carol subject');
        expect(hasNoPrintableText(result.messages[carolAt]!.message)).toBe(true);
        expect(result.messages[carolAt]!.message.attachments).toHaveLength(1);
        let checked = 0;
        for (const mode of MODES)
        {
            for (const positions of [[alice, bobAt, carolAt], [alice, bobAt], [alice, carolAt], [bobAt, carolAt]])
            {
                const made = make(result, mode, DEFAULT_OUTPUT_POLICY, positions);
                const where = `nested, ${mode.name}, ticked ${positions.join(',')}`;
                checked += expectKeptAttachedBlocks(made, where);
                const text = allText(made.pdf);
                // Carol's header lines: printed once (in bob's page) while bob and carol are ticked. With carol
                // unticked they are cut (Q3); with bob unticked they are cut with bob's block, as before (Q3).
                const carolHeader = text.split('Subject: carol subject').length - 1;
                expect(carolHeader, where).toBe(positions.includes(bobAt) && positions.includes(carolAt) ? 1 : 0);
                expect(text.split(squash(B_BODY)).length - 1, where).toBe(positions.includes(bobAt) ? 1 : 0);
                // Carol's attachment stays listed (in bob's list, and in alice's flat list).
                expect(text, where).toContain('carol-plan.pdf');
            }
        }
        // Per mode: [alice, bob, carol]: in bob and in alice (printed as bob); [alice, carol]: in alice (cut with
        // the unticked bob); [bob, carol]: in bob; [alice, bob]: carol unticked, not checked.
        expect(checked).toBe(3 * (2 + 1 + 1));
    });

    it('the generated PDF file: header lines with an attachment are printed, without one they are not', async () =>
    {
        const fonts = await loadPdfFonts();
        const pageText = async (result: ThreadAnalysisResult): Promise<string> =>
        {
            const positions = result.messages.map((_, k) => k);
            const made = await generatePdf({
                result,
                positions,
                plans: planOutput(positions.map((p) => result.messages[p]!)),
                policy: DEFAULT_OUTPUT_POLICY,
                generatedOffsetMinutes: 0,
                generatedAt: Date.UTC(2025, 5, 10, 12, 0, 0),
                fonts,
                locale: 'en',
            });
            const runs = await readPageRuns(readPdf(made.bytes));
            return runs.map((page) => textLines(page).map((l) => l.shown).join('\n')).join('\n');
        };
        const kept = await pageText(await headerOnly());
        expect(kept).toContain('Subject: bob subject');
        expect(kept).toContain('floor-plan.pdf');
        const cut = await pageText(analyzeThread([await parseEml('holder.eml', holding('alice', TUE, plain(OWN), rfc822(simple('bob', MON, ''))))]));
        expect(cut).not.toContain('bob subject');
        expect(cut).toContain('alice subject');
    });
});
