// Task 9.9b (user decisions 2026-11-19, F2 and F6): with "Print full original text" off,
// the PDF prints no header lines without text, and folds a forward whose rebuild failed as the
// preview folds it (Source/pdf-export/build-pdf-document.ts, NO-TEXT EMAILS and the no-repeat
// rule: kinds 'no-text' and 'not-rebuilt').
// - F2: a rebuilt email with no text (header lines only: an empty forward block, an empty
//   Outlook block, an empty attribution, at the top, at the very end, or right above a
//   near-identical one with text) gets no page, no index entry, no bookmark, and its header
//   lines are printed nowhere, not in the email it was read from nor in a newer rebuilt email,
//   whatever the reader ticked and with rebuilding on or off. The preview keeps its card and
//   labels the lines "Not in the PDF" (folded, never hidden for good).
// - F6: the part of a forward that could not be rebuilt is printed as the preview shows it: a
//   folded piece is left out, a piece shown is printed. Only while rebuilding is on. Header lines
//   with printed text under them stay (user decision Q3, review round 1 of task 9.9b-1): they say
//   who wrote it. Every preview label says truthfully whether its text is in the PDF (Q2, Q6).
// - "Print full original text" prints every body whole, as before.
// The phone-forward fixtures 94 to 97 are checked in Source/thread-analysis/analyze-thread.phone-forward.test.ts
// and below; 98 (HTML only) in the browser (Helper/Test/browser-tests/rebuilt.spec.ts).
// Synthetic data only (README.md, rule R7).
import { describe, expect, it } from 'vitest';
import { FORWARDED_SEPARATOR } from '../email-reading/forwarded-block';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all-fixtures';
import { phoneForwardThread } from '../../Helper/Test/test-support/phone-forward-thread';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { rebuiltHasNoPrintableText } from '../web-page-logic/no-printable-text';
import { pdfBlocks } from '../web-page-logic/pdf-plan';
import { printedElsewhereRanges, type PrintedElsewhereInput } from '../web-page-logic/printed-elsewhere';
import { rebuiltEntries } from '../web-page-logic/rebuilt-email-display';
import { applyNoRepeatRule, buildPdfDocument, notRebuiltParts, pdfRanges } from './build-pdf-document';
import { createPdfStrings } from './pdf-strings';
import { bodyLines, lineText } from './pdf-text-transforms';
import type { MessagePlan, OutputPolicy } from '../../Header/output-plan';
import type { NormalizedMessage, ParseResult } from '../../Header/parsed-email';
import type { PdfDocument, PdfEmail } from '../../Header/pdf-document-model';
import type { Segment, ThreadAnalysisResult } from '../../Header/thread-analysis-result';

const EN = createPdfStrings('en');
const FULL: OutputPolicy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };

function file(subject: string, bodyText: string, fileNumber = 1): NormalizedMessage
{
    const utcMs = Date.UTC(2025, 2, 5, 9, 0);
    return {
        messageId: `lone-headers-${String(fileNumber)}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs, original: new Date(utcMs).toUTCString(), offsetMinutes: 0, zoneKnown: true },
        from: [{ name: 'Alice Example', address: 'alice@example.test' }],
        to: [{ name: 'Carol Sample', address: 'carol@example.test' }],
        cc: [],
        bcc: [],
        subject,
        bodyText,
        attachments: [],
        source: { fileName: `lone-headers-${String(fileNumber)}.eml`, sha256: String(fileNumber).padStart(64, '0'), kind: 'eml' },
        warnings: [],
    };
}

/** The default modes of the PDF: what the reader ticked, rebuilding on or off. */
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

function make(messages: readonly NormalizedMessage[], mode: Mode, policy: OutputPolicy = DEFAULT_OUTPUT_POLICY): Made
{
    return makeFrom(messages.map((message) => ({ ok: true as const, message })), mode, policy);
}

/** make, from what the readers return (an .eml with attached emails). */
function makeFrom(files: readonly ParseResult[], mode: Mode, policy: OutputPolicy = DEFAULT_OUTPUT_POLICY): Made
{
    const result = analyzeThread(files);
    const positions = result.messages.map((_, k) => k);
    const plans = planOutput(positions.map((p) => result.messages[p]!), policy);
    const ids = rebuiltEntries(result).map((r) => r.id);
    const input: PrintedElsewhereInput = { result, positions, plans, policy, rebuilt: mode.rebuilt(ids), unticked: mode.unticked(ids), rebuildingOff: mode.off };
    const pdf = buildPdfDocument({ ...input, timeZone: 'UTC', generatedAt: Date.UTC(2025, 5, 1, 12, 0, 0), strings: EN });
    return { result, positions, plans, input, pdf };
}

const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');
const squash = (s: string): string => s.replace(/\s+/gu, ' ').trim();
/** A body as the PDF prints it whole (without its quote markers), squashed. */
const asPrinted = (body: string): string => squash(bodyLines(body).lines.map(lineText).join('\n'));
const allText = (pdf: PdfDocument): string => squash(pdf.emails.map((e) => `${e.fields.map((f) => f.value.map(lineText).join(' ')).join('\n')}\n${bodyOf(e)}`).join('\n'));

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

/** The preview's labelled blocks of the email at `position`, as Source/web-page/pdf-labels.ts makes them. */
function previewBlocks(made: Made, position: number): ReturnType<typeof pdfBlocks>
{
    const { result, plans, input } = made;
    const analyzed = result.messages[position]!;
    const pdfRangesHere = printedElsewhereRanges(input).get(position);
    const view = { plan: plans[made.positions.indexOf(position)]!, signatureFrom: new Map<number, number>(), ...(pdfRangesHere === undefined ? {} : { pdfRanges: pdfRangesHere }) };
    return pdfBlocks(analyzed.message.bodyText, analyzed.segments, view);
}

/**
 * F2 on one input, in every default mode: each rebuilt email with no text has a card (an entry) but no
 * page and no index entry, no non-blank character of its place is printed, the preview labels them
 * "not in the PDF" ('no-text') where the plan would have printed them, and the joined preview blocks
 * still give the whole body. "Print full original text" prints every body whole.
 * Returns how many empty places were checked.
 */
function expectNoLoneHeaders(messages: readonly NormalizedMessage[], what: string): number
{
    let checked = 0;
    for (const mode of MODES)
    {
        const made = make(messages, mode);
        const { result, pdf } = made;
        const where = `${what}, ${mode.name}`;
        const empties = result.reconstructed.filter((r) => rebuiltHasNoPrintableText(r));
        expect(empties.length, where).toBeGreaterThan(0);
        expect(pdf.emails.length, where).toBe(pdf.index.entries.length);
        for (const empty of empties)
        {
            const position = result.positionByIndex[empty.sourceIndex]!;
            const body = result.messages[position]!.message.bodyText;
            const { start, headerEnd, end } = empty.rebuilt;
            // A card in the preview (an entry of its own, or a copy of one), no page.
            expect(empty.link === 'entry' || empty.link === 'same-as', where).toBe(true);
            expect(pdf.emails.some((e) => e.rebuilt?.id === empty.id || e.rebuilt?.shownId === empty.id), where).toBe(false);
            // Not one character of its place printed in the email it was read from.
            const printed = printedChars(made, position);
            for (let i = start; i < end; i++)
            {
                expect(printed[i] === 1 && /\S/u.test(body[i]!), `${where}: "${squash(body.slice(start, headerEnd))}" printed at ${String(i)}`).toBe(false);
            }
            // The preview: every block over its header lines is folded or labelled out; the blocks give the body back.
            const blocks = previewBlocks(made, position);
            expect(blocks.map((b) => b.block.text).join(''), where).toBe(body);
            for (const { label } of blocks.filter((b) => b.block.start < headerEnd && start < b.block.end && /\S/u.test(b.block.text)))
            {
                expect(label?.status, where).toBe('out');
            }
            const ranges = printedElsewhereRanges(made.input).get(position) ?? [];
            if (made.plans[made.positions.indexOf(position)]!.ranges.some((r) => r.keep && r.start < headerEnd && start < r.end))
            {
                expect(ranges.some((r) => r.printedAs?.kind === 'no-text' && r.printedAs.id === empty.id), `${where}: labelled 'no-text'`).toBe(true);
            }
            checked++;
        }
    }
    // "Print full original text": every body printed whole, header lines with no text included.
    const full = make(messages, MODES[0], FULL);
    for (const position of full.positions)
    {
        const email = full.pdf.emails.find((e) => e.position === position)!;
        expect(bodyOf(email), `${what}, full text`).toBe(bodyLines(full.result.messages[position]!.message.bodyText).lines.map(lineText).join('\n'));
    }
    expect(full.pdf.emails.every((e) => e.rebuilt === null), `${what}, full text`).toBe(true);
    return checked;
}

const EMPTY_FORWARD_AT_TOP =
    '---------- Forwarded message ---------\nFrom: Alice Example <alice@example.test>\nDate: Mon, 3 Mar 2025 at 10:00\nSubject: Fwd: Desk order\nTo: Carol Sample <carol@example.test>\n\n\n' +
    '---------- Forwarded message ---------\nFrom: Bob Sample <bob@example.test>\nDate: Fri, 28 Feb 2025 at 16:30\nSubject: Desk order\nTo: Alice Example <alice@example.test>\n\n' +
    'The twelve oak desks are ready for delivery on Friday.\n\nBob\n';
const EMPTY_OUTLOOK_BLOCK =
    'Carol, see below.\n\nAlice\n\n' +
    '-----Original Message-----\nFrom: Bob Sample <bob@example.test>\nSent: Monday, March 3, 2025 10:00 AM\nTo: Alice Example <alice@example.test>\nSubject: RE: Desk order\n\n' +
    '-----Original Message-----\nFrom: Bob Sample <bob@example.test>\nSent: Monday, March 3, 2025 9:55 AM\nTo: Alice Example <alice@example.test>\nSubject: RE: Desk order\n\n' +
    'The twelve oak desks are ready for delivery on Friday.\n\nBob\n';
const ATTRIBUTION_AT_THE_END = 'Carol, the desks arrive on Friday.\n\nAlice\n\nOn Mon, 3 Mar 2025 at 10:00, Bob Sample <bob@example.test> wrote:\n';
const EMPTY_ABOVE_ITS_TWIN =
    '---------- Forwarded message ---------\nFrom: Alice Example <alice@example.test>\nDate: Mon, 3 Mar 2025 at 10:00\nSubject: Fwd: Desk order\nTo: Carol Sample <carol@example.test>\n\n' +
    'On Fri, 28 Feb 2025 at 16:30, Bob Sample <bob@example.test> wrote:\n\n' +
    'On Fri, 28 Feb 2025 at 16:30, Bob Sample <bob@example.test> wrote:\n\n' +
    'The twelve oak desks are ready for delivery on Friday.\n\nBob\n';

describe('F2: an email with no text puts nothing in the PDF, not even its header lines (task 9.9b)', () =>
{
    it('an empty forward block at the top: no page, its lines nowhere; the forward under it is printed once', () =>
    {
        const message = file('Fwd: Fwd: Desk order', EMPTY_FORWARD_AT_TOP);
        expect(expectNoLoneHeaders([message], 'empty forward')).toBe(3);
        const { pdf } = make([message], MODES[0]);
        expect(pdf.emails.map((e) => e.rebuilt === null ? 'file' : 'rebuilt')).toEqual(['rebuilt', 'file']);
        expect(pdf.index.entries).toHaveLength(2);
        expect(allText(pdf)).not.toContain('From: Alice Example');
        expect(allText(pdf).split('The twelve oak desks are ready').length - 1).toBe(1);
        // The file's own text: nothing left of it (every part printed elsewhere or empty): the placeholder.
        expect(pdf.emails[1]!.body).toEqual([]);
        expect(pdf.emails[1]!.notes.map(lineText)).toEqual(['(no text)']);
    });

    it('an empty Outlook block over another one: its lines nowhere, the writer\'s own text kept', () =>
    {
        const message = file('Fwd: RE: Desk order', EMPTY_OUTLOOK_BLOCK);
        expect(expectNoLoneHeaders([message], 'empty Outlook block')).toBe(3);
        for (const mode of MODES)
        {
            const { pdf } = make([message], mode);
            const text = allText(pdf);
            expect(text, mode.name).not.toContain('Sent: Monday, March 3, 2025 10:00 AM');
            expect(text, mode.name).toContain('Carol, see below.');
            // Printed once (as its rebuilt email, or inline with rebuilding off); unticked, left out with it (Q2).
            expect(text.split('The twelve oak desks are ready').length - 1, mode.name).toBe(mode === MODES[1] ? 0 : 1);
        }
    });

    it('a strict attribution at the very end of a body (reply or forward subject): its line is not printed', () =>
    {
        for (const subject of ['Re: Desk order', 'Fwd: Desk order'])
        {
            const message = file(subject, ATTRIBUTION_AT_THE_END);
            expect(expectNoLoneHeaders([message], subject)).toBe(3);
            for (const mode of MODES)
            {
                const { pdf } = make([message], mode);
                expect(allText(pdf), `${subject}, ${mode.name}`).not.toContain('wrote:');
                expect(squash(bodyOf(pdf.emails[0]!)), `${subject}, ${mode.name}`).toBe('Carol, the desks arrive on Friday. Alice');
            }
        }
    });

    it('an empty attribution right above a near-identical one with text: the empty one nowhere, the other printed once', () =>
    {
        const message = file('Fwd: Desk order', EMPTY_ABOVE_ITS_TWIN);
        // Two empty ones (the forward block and the first attribution), in 3 modes.
        expect(expectNoLoneHeaders([message], 'empty twin')).toBe(6);
        const attribution = 'On Fri, 28 Feb 2025 at 16:30, Bob Sample <bob@example.test> wrote:';
        for (const mode of MODES)
        {
            const { pdf } = make([message], mode);
            const text = allText(pdf);
            expect(text.split('The twelve oak desks are ready').length - 1, mode.name).toBe(mode === MODES[1] ? 0 : 1);
            // At most once: with the text under it (inline when rebuilding is off, moved to its rebuilt email when
            // its date cannot be shown by the header rows); never twice.
            expect(text.split(attribution).length - 1, mode.name).toBeLessThanOrEqual(mode === MODES[1] ? 0 : 1);
            expect(text, mode.name).not.toContain('From: Alice Example');
        }
    });

    it('fixtures 94 to 97 (the phone forward of task 9.9a), alone and together: the 3 empty emails print nothing', async () =>
    {
        const files = import.meta.glob<string>('../../Helper/Test/test-data/eml/9[4-7]-*.eml', { query: '?raw', import: 'default', eager: true });
        const { createEmlParser } = await import('../email-reading/eml-parser');
        const parser = createEmlParser({ htmlToText: () => ({ text: '[stub html-to-text]', truncated: false }) });
        const messages: NormalizedMessage[] = [];
        for (const [name, raw] of Object.entries(files).sort())
        {
            const parsed = await parser.parse({ name, bytes: new TextEncoder().encode(raw) });
            expect(parsed.ok, name).toBe(true);
            if (parsed.ok)
            {
                messages.push(parsed.message);
            }
        }
        expect(messages).toHaveLength(4);
        const french = phoneForwardThread('fr');
        const empty = french.expected.filter((e) => e.noOwnText);
        expect(empty).toHaveLength(3);
        for (const message of messages)
        {
            // 3 empty emails, in 3 modes.
            expect(expectNoLoneHeaders([message], message.source.fileName)).toBe(9);
            const { pdf } = make([message], MODES[0]);
            // 10 rebuilt emails and the file.
            expect(pdf.emails.filter((e) => e.rebuilt !== null)).toHaveLength(10);
            expect(pdf.emails.filter((e) => e.rebuilt === null)).toHaveLength(1);
            expect(pdf.index.entries).toHaveLength(11);
            // The empty forward's own lines (its date is that of the forward itself) are nowhere in the PDF.
            expect(allText(pdf), message.source.fileName).not.toContain('17 nov. 2026 19:23');
        }
        // All four together (the same thread in four files: their rebuilt emails are copies of each other).
        expect(expectNoLoneHeaders(messages, 'fixtures 94 to 97 together')).toBe(36);
        expect(allText(make(messages, MODES[0]).pdf)).not.toContain('17 nov. 2026 19:23');
    });
});

const REFUSED_FORWARD =
    'Hi Carol,\n\nSee the invoice note below.\n\nAlice\n\n' +
    '---------- Forwarded message ---------\nFrom: the accounting team\nDate: sometime in March\nSubject: Desk invoice\n\n' +
    'The invoice for the twelve oak desks is attached.\n';
const CHAIN_THAT_STOPS =
    'Hi Carol,\n\nBelow.\n\nAlice\n\n' +
    '---------- Forwarded message ---------\nFrom: Bob Sample <bob@example.test>\nDate: Tue, 4 Mar 2025 at 09:00\nSubject: Fwd: Fwd: Desk invoice\nTo: Alice Example <alice@example.test>\n\n' +
    'Alice, see the note below.\n\nBob\n\n' +
    '---------- Forwarded message ---------\nFrom: Dan Example <dan@example.test>\nDate: Mon, 3 Mar 2025 at 08:00\nSubject: Fwd: Desk invoice\nTo: Bob Sample <bob@example.test>\n\n' +
    'Bob, the accounting note.\n\nDan\n\n' +
    '---------- Forwarded message ---------\nFrom: the accounting team\nDate: sometime in March\nSubject: Desk invoice\n\n' +
    'The invoice for the twelve oak desks is attached.\n';
// A refused forward whose only text is a `>` quote (folded in the preview): nothing is printed under its header lines.
const REFUSED_OVER_A_QUOTE =
    'Hi Carol,\n\nSee the invoice note below.\n\nAlice\n\n' +
    '---------- Forwarded message ---------\nFrom: the accounting team\nDate: sometime in March\nSubject: Desk invoice\n\n' +
    '> The invoice for the twelve oak desks is attached.\n> It is due by the end of March.\n';

// Review round 2 of task 9.9b-1: a refused forward header with no text of its own, right above (after a blank line)
// another refused forward header, or an "On ... wrote:" line, that has text under it.
const LONE_THEN_FORWARD =
    'Hi Carol,\n\nSee the invoice note below.\n\nAlice\n\n' +
    '---------- Forwarded message ---------\nFrom: the front desk\nDate: sometime in April\nSubject: Desk invoice\n\n' +
    '---------- Forwarded message ---------\nFrom: the accounting team\nDate: sometime in March\nSubject: Desk invoice\n\n' +
    'The invoice for the twelve oak desks is attached.\n';
const LONE_THEN_ATTRIBUTION =
    'Hi Carol,\n\nSee the invoice note below.\n\nAlice\n\n' +
    '---------- Forwarded message ---------\nFrom: the front desk\nDate: sometime in April\nSubject: Desk invoice\n\n' +
    'On Mon, 3 Mar 2025 at 08:00, the accounting team <accounts@example.test> wrote:\n' +
    'The invoice for the twelve oak desks is attached.\n';
// Review round 3 of task 9.9b-1: a refused forward header whose only text is a `>` quote (folded) right above another
// refused forward header with text under it.
const LONE_OVER_A_QUOTE_THEN_FORWARD =
    'Hi Carol,\n\nSee the invoice note below.\n\nAlice\n\n' +
    '---------- Forwarded message ---------\nFrom: the front desk\nDate: sometime in April\nSubject: Desk invoice\n\n' +
    '> The invoice for the twelve oak desks is attached.\n> It is due by the end of March.\n' +
    '---------- Forwarded message ---------\nFrom: the accounting team\nDate: sometime in March\nSubject: Desk invoice\n\n' +
    'Short note.\n';
// Review round 3 of task 9.9b-1: a refused forward header with text, then another refused forward header with text
// (OVERLAP_LATER, the later file); an earlier file quotes the first header, its text and the second header
// (OVERLAP_EARLIER), or only the first header and its text (OVERLAP_EARLIER_FIRST_ONLY).
const OVERLAP_FIRST =
    '---------- Forwarded message ---------\nFrom: the front desk\nDate: sometime in April\nSubject: Desk invoice\n\n' +
    'The invoice for the twelve oak desks is attached, and it is due by the end of March this year.\n\n';
const OVERLAP_SECOND = '---------- Forwarded message ---------\nFrom: the accounting team\nDate: sometime in March\nSubject: Desk invoice\n\n';
const OVERLAP_LATER = `Hi Carol,\n\nSee the invoice note below.\n\nAlice\n\n${OVERLAP_FIRST}${OVERLAP_SECOND}Short note.\n`;
const OVERLAP_EARLIER =
    `Hi Dan,\n\nForwarding the note from the front desk to you now.\n\nErin\n\n${OVERLAP_FIRST}${OVERLAP_SECOND}` +
    'A longer note from the accounting team about the desks and the chairs and the lamps.\n';
const OVERLAP_EARLIER_FIRST_ONLY = `Hi Dan,\n\nForwarding the note from the front desk to you now.\n\nErin\n\n${OVERLAP_FIRST}Erin\n`;

/** Where the forwarded part of `body` starts, and where the block of an attached email the .eml reader wrote starts (else the end). */
function forwardedPart(body: string, plan: MessagePlan): { readonly forwardedAt: number; readonly attachedAt: number }
{
    const forwardedAt = plan.ranges.find((r) => r.reason === 'forwarded')!.start;
    const separator = body.indexOf(`\n${FORWARDED_SEPARATOR}\n`, forwardedAt - 1);
    return { forwardedAt, attachedAt: separator < 0 ? body.length : separator + 1 };
}

/**
 * F6 and Q3 (review round 1 of task 9.9b-1): in the forwarded part of the email at `position`, outside every
 * rebuilt place, a non-blank character is printed exactly when the preview's label says "In the PDF" (a shown
 * block has no label: always in). Text the preview shows is always printed; a folded piece only when it is
 * header lines (fold reason 'reply-header') with printed text under them.
 * Returns how many folded non-blank characters were left out and how many were kept.
 */
function expectPdfFoldsAsPreview(made: Made, position: number, where: string): { readonly cut: number; readonly kept: number }
{
    const { result, plans } = made;
    const body = result.messages[position]!.message.bodyText;
    const plan = plans[made.positions.indexOf(position)]!;
    const { forwardedAt, attachedAt } = forwardedPart(body, plan);
    const places = result.reconstructed.filter((r) => result.positionByIndex[r.sourceIndex] === position).map((r) => r.rebuilt);
    const printed = printedChars(made, position);
    let cut = 0;
    let kept = 0;
    for (const { block, label } of previewBlocks(made, position))
    {
        for (let i = Math.max(block.start, forwardedAt); i < Math.min(block.end, attachedAt); i++)
        {
            if (!/\S/u.test(body[i]!) || places.some((p) => p.start <= i && i < p.end))
            {
                continue;
            }
            const at = `${where}: "${squash(block.text).slice(0, 50)}" at ${String(i)}`;
            // The preview says exactly what the PDF prints.
            expect(label?.status ?? 'in', at).toBe(printed[i] === 1 ? 'in' : 'out');
            if (!block.folded)
            {
                expect(printed[i], `${at}: shown, so printed`).toBe(1);
                continue;
            }
            if (printed[i] === 1)
            {
                expect(block.reasons, `${at}: only header lines are printed folded`).toContain('reply-header');
                kept++;
            }
            else
            {
                cut++;
            }
        }
    }
    return { cut, kept };
}

/**
 * Q3 (user decision 2026-11-21, review round 1 of task 9.9b-1): every forwarded paragraph outside a rebuilt
 * place that the PDF prints (a run of shown text) is preceded in the PDF by the header lines above it (the last
 * folded 'reply-header' segment above it with no place in between), so forwarded text never reads as the
 * holder's own words. Returns how many paragraphs had header lines to check.
 */
function expectHeaderLinesAboveText(made: Made, position: number, where: string): number
{
    const { result, plans } = made;
    const analyzed = result.messages[position]!;
    const body = analyzed.message.bodyText;
    const plan = plans[made.positions.indexOf(position)]!;
    const { forwardedAt, attachedAt } = forwardedPart(body, plan);
    const places = result.reconstructed.filter((r) => result.positionByIndex[r.sourceIndex] === position).map((r) => r.rebuilt);
    const inPlace = (i: number): boolean => places.some((p) => p.start <= i && i < p.end);
    const printed = printedChars(made, position);
    const pdfText = squash(bodyOf(made.pdf.emails.find((e) => e.position === position && e.rebuilt === null)!));
    const inForwardedPart = (s: Segment): boolean => s.start >= forwardedAt && s.start < attachedAt && !inPlace(s.start);
    const headers = analyzed.segments.filter((s) => s.folded && s.reasons.includes('reply-header') && inForwardedPart(s));
    let checked = 0;
    for (const paragraph of analyzed.segments.filter((s) => !s.folded && inForwardedPart(s) && /\S/u.test(body.slice(s.start, s.end))))
    {
        const header = headers.filter((h) => h.end <= paragraph.start).at(-1);
        if (header === undefined || places.some((p) => p.start >= header.end && p.start < paragraph.start))
        {
            continue;
        }
        const headerText = squash(body.slice(header.start, header.end));
        const paragraphText = squash(body.slice(paragraph.start, paragraph.end));
        for (let i = header.start; i < header.end; i++)
        {
            expect(printed[i] === 1 || !/\S/u.test(body[i]!), `${where}: header "${headerText.slice(0, 50)}" printed above "${paragraphText.slice(0, 30)}"`).toBe(true);
        }
        const headerAt = pdfText.indexOf(headerText);
        expect(headerAt, `${where}: "${headerText.slice(0, 50)}" in the PDF`).toBeGreaterThanOrEqual(0);
        expect(pdfText.indexOf(paragraphText, headerAt + headerText.length), `${where}: "${paragraphText.slice(0, 30)}" under its header lines`).toBeGreaterThan(headerAt);
        checked++;
    }
    return checked;
}

describe('F6: a forward whose rebuild failed is folded in the PDF as in the preview, header lines with text under them kept (task 9.9b)', () =>
{
    it('a refused forward header with text under it: its header lines and text printed, the preview says "In the PDF"', () =>
    {
        const message = file('Fwd: Desk invoice', REFUSED_FORWARD);
        for (const mode of MODES)
        {
            const made = make([message], mode);
            expect(made.result.reconstructed).toEqual([]);
            // Before review round 1 of task 9.9b-1, F6 left these header lines out; now nothing is cut (Q3).
            const { cut, kept } = expectPdfFoldsAsPreview(made, 0, `refused, ${mode.name}`);
            expect(cut).toBe(0);
            expect(kept).toBeGreaterThan(50);
            expect(expectHeaderLinesAboveText(made, 0, `refused, ${mode.name}`)).toBe(1);
            expect(squash(bodyOf(made.pdf.emails[0]!))).toBe(squash(REFUSED_FORWARD));
            expect(printedElsewhereRanges(made.input).get(0)).toBeUndefined();
        }
    });

    it('a refused forward over a folded `>` quote: nothing printed under it, so its header lines and the quote are left out', () =>
    {
        const message = file('Fwd: Desk invoice', REFUSED_OVER_A_QUOTE);
        const made = make([message], MODES[0]);
        expect(made.result.reconstructed).toEqual([]);
        const { cut, kept } = expectPdfFoldsAsPreview(made, 0, 'refused over a quote');
        expect(kept).toBe(0);
        expect(cut).toBeGreaterThan(100);
        expect(squash(bodyOf(made.pdf.emails[0]!))).toBe('Hi Carol, See the invoice note below. Alice');
        // The preview's label names it (no email prints it).
        const ranges = printedElsewhereRanges(made.input).get(0)!;
        expect(ranges.filter((r) => r.printedAs !== null).length).toBeGreaterThan(0);
        expect(ranges.filter((r) => r.printedAs !== null).every((r) => r.printedAs?.kind === 'not-rebuilt')).toBe(true);
        // Rebuilding off: printed as the plan says (F6 needs rebuilding on).
        expect(squash(bodyOf(make([message], MODES[2]).pdf.emails[0]!))).toBe(asPrinted(REFUSED_OVER_A_QUOTE));
    });

    it('a chain that stops at a refused header: the rebuilt email on its own, every header line with text under it kept', () =>
    {
        const message = file('Fwd: Fwd: Fwd: Desk invoice', CHAIN_THAT_STOPS);
        const made = make([message], MODES[0]);
        // Only Bob's forward is rebuilt: Dan's holds the refused header, so it is dropped too.
        expect(made.result.reconstructed.map((r) => r.rebuilt.from[0]?.address)).toEqual(['bob@example.test']);
        expect(expectPdfFoldsAsPreview(made, 0, 'chain').cut).toBe(0);
        // Before review round 1 of task 9.9b-1, F6 left out Dan's complete, readable header lines (and the refused
        // ones) just because the chain stopped at a later refused header: now each stays above its text (Q3).
        expect(expectHeaderLinesAboveText(made, 0, 'chain')).toBe(2);
        expect(made.pdf.emails.map((e) => (e.rebuilt === null ? 'file' : 'rebuilt'))).toEqual(['rebuilt', 'file']);
        // Its text (under its own header lines, moved there: its time has no zone the Date row could show, Q4 of task 8.13a).
        expect(squash(bodyOf(made.pdf.emails[0]!)).endsWith('Subject: Fwd: Fwd: Desk invoice To: Alice Example <alice@example.test> Alice, see the note below. Bob')).toBe(true);
        const danAndAccounting = squash(CHAIN_THAT_STOPS.slice(CHAIN_THAT_STOPS.indexOf('---------- Forwarded message ---------\nFrom: Dan')));
        expect(squash(bodyOf(made.pdf.emails[1]!))).toBe(`Hi Carol, Below. Alice ${danAndAccounting}`);
        // Every rebuilt email unticked: Bob's forward left out with it (Q2), the rest as above.
        const unticked = make([message], MODES[1]);
        expect(expectPdfFoldsAsPreview(unticked, 0, 'chain, unticked').cut).toBe(0);
        expect(expectHeaderLinesAboveText(unticked, 0, 'chain, unticked')).toBe(2);
        expect(squash(bodyOf(unticked.pdf.emails[0]!))).toBe(`Hi Carol, Below. Alice ${danAndAccounting}`);
    });

    it('a refused forward header with no text of its own above another header with text: the first left out, the second and its text printed (review round 2 of task 9.9b-1)', () =>
    {
        for (const [name, body, second] of [
            ['two forward headers', LONE_THEN_FORWARD, 'From: the accounting team'],
            ['forward header then attribution', LONE_THEN_ATTRIBUTION, 'On Mon, 3 Mar 2025 at 08:00, the accounting team <accounts@example.test> wrote:'],
        ] as const)
        {
            const made = make([file('Fwd: Desk invoice', body)], MODES[0]);
            expect(made.result.reconstructed, name).toEqual([]);
            const { cut, kept } = expectPdfFoldsAsPreview(made, 0, name);
            expect(cut, name).toBeGreaterThan(40);
            expect(kept, name).toBeGreaterThan(20);
            expect(expectHeaderLinesAboveText(made, 0, name)).toBe(1);
            const pdfText = squash(bodyOf(made.pdf.emails[0]!));
            // The first header's lines are nowhere in the PDF; the preview names them as not rebuilt.
            expect(pdfText, name).not.toContain('the front desk');
            expect(pdfText, name).not.toContain('sometime in April');
            const firstAt = body.indexOf('From: the front desk');
            const label = printedElsewhereRanges(made.input).get(0)!.find((r) => r.start <= firstAt && firstAt < r.end);
            expect(label?.printedAs?.kind, name).toBe('not-rebuilt');
            // The second header and its text are printed, the text under the header.
            expect(pdfText, name).toContain(`${second}`);
            expect(pdfText.indexOf('The invoice for the twelve oak desks is attached.'), name).toBeGreaterThan(pdfText.indexOf(second));
        }
    });

    it('rebuilding off: nothing could fail to rebuild, the forward is printed as its plan says (header lines included), the preview says "In the PDF"', () =>
    {
        for (const body of [REFUSED_FORWARD, CHAIN_THAT_STOPS, REFUSED_OVER_A_QUOTE])
        {
            const made = make([file('Fwd: Desk invoice', body)], MODES[2]);
            expect(applyNoRepeatRule(made.input).parts.size).toBe(0);
            expect(squash(bodyOf(made.pdf.emails[0]!))).toBe(asPrinted(body));
            // Q2 (user decision 2026-11-21): the folded header lines are printed, so their label says "In the PDF".
            const { cut, kept } = expectPdfFoldsAsPreview(made, 0, 'rebuilding off');
            expect(cut).toBe(0);
            expect(kept).toBeGreaterThan(50);
        }
    });

    it('"Print full original text": every body printed whole, as before', () =>
    {
        for (const body of [REFUSED_FORWARD, CHAIN_THAT_STOPS, REFUSED_OVER_A_QUOTE])
        {
            const made = make([file('Fwd: Desk invoice', body)], MODES[0], FULL);
            expect(applyNoRepeatRule(made.input).parts.size).toBe(0);
            expect(bodyOf(made.pdf.emails[0]!)).toBe(bodyLines(body).lines.map(lineText).join('\n'));
        }
    });

    it('notRebuiltParts: only folded pieces of the forwarded part outside the places, never an attached email\'s block, never header lines with shown text under them', () =>
    {
        const body = 'Own text.\n\nHEADER\nA quoted line.\n> folded\n---------- Forwarded message ----------\nFrom: x\n\nAttached text.\n';
        const at = (s: string): number => body.indexOf(s);
        const segment = (start: number, end: number, reasons: readonly ('reply-header' | 'quote-marker')[]): Segment =>
            ({ start, end, folded: reasons.length > 0, reasons, related: [] });
        const segments = [
            segment(0, at('HEADER'), []),
            segment(at('HEADER'), at('A quoted'), ['reply-header']),
            segment(at('A quoted'), at('> folded'), []),
            segment(at('> folded'), at('----------'), ['quote-marker']),
            segment(at('----------'), body.length, ['reply-header']),
        ];
        const ranges = [
            { start: 0, end: at('HEADER'), keep: true, reason: 'text' as const },
            { start: at('HEADER'), end: body.length, keep: true, reason: 'forwarded' as const },
        ];
        const notRebuilt = { kind: 'not-rebuilt' } as const;
        // The header lines have shown text under them: kept. The folded quote: cut. The attached block: never.
        expect(notRebuiltParts(body, segments, ranges, [])).toEqual([{ start: at('> folded'), end: at('----------'), printedAs: notRebuilt }]);
        // The text under them folded too: nothing printed under the header lines, so they are cut as well.
        const allFolded = segments.map((s, k) => (k === 2 ? segment(s.start, s.end, ['quote-marker']) : s));
        expect(notRebuiltParts(body, allFolded, ranges, [])).toEqual([
            { start: at('HEADER'), end: at('A quoted'), printedAs: notRebuilt },
            { start: at('A quoted'), end: at('> folded'), printedAs: notRebuilt },
            { start: at('> folded'), end: at('----------'), printedAs: notRebuilt },
        ]);
        // The text under them is a rebuilt place (printed as its own email): nothing printed right under the header lines.
        expect(notRebuiltParts(body, segments, ranges, [[at('A quoted'), at('> folded')]])).toEqual([
            { start: at('HEADER'), end: at('A quoted'), printedAs: notRebuilt },
            { start: at('> folded'), end: at('----------'), printedAs: notRebuilt },
        ]);
        // Inside a rebuilt place: nothing.
        expect(notRebuiltParts(body, segments, ranges, [[at('HEADER'), at('----------')]])).toEqual([]);
        // No forwarded part, or no list of segments: nothing.
        expect(notRebuiltParts(body, segments, [{ start: 0, end: body.length, keep: true, reason: 'text' }], [])).toEqual([]);
        expect(notRebuiltParts(body, null as unknown as Segment[], ranges, [])).toEqual([]);
        // A malformed folded segment cuts nothing and hides no shown text (when unsure, keep).
        const malformed = [...allFolded.slice(0, 2), segment(at('A quoted'), at('> folded') + 0.5, ['quote-marker']), ...allFolded.slice(3)];
        expect(notRebuiltParts(body, malformed, ranges, [])).toEqual([{ start: at('> folded'), end: at('----------'), printedAs: notRebuilt }]);
    });

    it('notRebuiltParts: header lines whose only text is under the next block of header lines are cut (review round 2 of task 9.9b-1)', () =>
    {
        const body = 'Own text.\n\nHEADER1\n\nHEADER2\nText of the second.\n';
        const at = (s: string): number => body.indexOf(s);
        const segment = (start: number, end: number, reasons: readonly ('reply-header' | 'quoted-overlap')[]): Segment =>
            ({ start, end, folded: reasons.length > 0, reasons, related: [] });
        const ranges = [
            { start: 0, end: at('HEADER1'), keep: true, reason: 'text' as const },
            { start: at('HEADER1'), end: body.length, keep: true, reason: 'forwarded' as const },
        ];
        const segments = [
            segment(0, at('HEADER1'), []),
            segment(at('HEADER1'), at('\nHEADER2'), ['reply-header']),
            segment(at('\nHEADER2'), at('HEADER2'), []),
            segment(at('HEADER2'), at('Text of'), ['reply-header']),
            segment(at('Text of'), body.length, []),
        ];
        // HEADER1 has only a blank line under it before HEADER2: a lone header, cut. HEADER2 has its text: kept.
        expect(notRebuiltParts(body, segments, ranges, [])).toEqual([{ start: at('HEADER1'), end: at('\nHEADER2'), printedAs: { kind: 'not-rebuilt' } }]);
        // One header block split into two folded segments where another fold overlaps it (buildSegments): the
        // second piece starts no block of its own, so the upper piece keeps the text under the block and stays.
        const split = [
            segment(0, at('HEADER1'), []),
            segment(at('HEADER1'), at('HEADER2'), ['quoted-overlap', 'reply-header']),
            segment(at('HEADER2'), at('Text of'), ['reply-header']),
            segment(at('Text of'), body.length, []),
        ];
        expect(notRebuiltParts(body, split, ranges, [])).toEqual([]);
    });

    it('notRebuiltParts: a block of header lines starts after a folded piece that is not header lines too (review round 3 of task 9.9b-1)', () =>
    {
        const body = 'Own text.\n\nHEADER1\n\n> a quote\nHEADER2\nText of the second.\n';
        const at = (s: string): number => body.indexOf(s);
        const segment = (start: number, end: number, reasons: readonly ('reply-header' | 'quote-marker' | 'quoted-overlap')[]): Segment =>
            ({ start, end, folded: reasons.length > 0, reasons, related: [] });
        const ranges = [
            { start: 0, end: at('HEADER1'), keep: true, reason: 'text' as const },
            { start: at('HEADER1'), end: body.length, keep: true, reason: 'forwarded' as const },
        ];
        const notRebuilt = { kind: 'not-rebuilt' } as const;
        // HEADER1, a blank line, a folded piece that is not header lines, then HEADER2 right after it: HEADER2 starts a
        // block of its own, so the text under it is not under HEADER1. HEADER1 and the folded piece cut, HEADER2 kept.
        for (const reason of ['quote-marker', 'quoted-overlap'] as const)
        {
            const segments = [
                segment(0, at('HEADER1'), []),
                segment(at('HEADER1'), at('\n> a quote'), ['reply-header']),
                segment(at('\n> a quote'), at('> a quote'), []),
                segment(at('> a quote'), at('HEADER2'), [reason]),
                segment(at('HEADER2'), at('Text of'), ['reply-header']),
                segment(at('Text of'), body.length, []),
            ];
            expect(notRebuiltParts(body, segments, ranges, []), reason).toEqual([
                { start: at('HEADER1'), end: at('\n> a quote'), printedAs: notRebuilt },
                { start: at('> a quote'), end: at('HEADER2'), printedAs: notRebuilt },
            ]);
            // The same with HEADER2's piece also folded for that reason (an overlap over both): still a block of its own.
            const both = segments.map((s, k) => (k === 4 ? segment(s.start, s.end, [reason, 'reply-header']) : s));
            expect(notRebuiltParts(body, both, ranges, []), `${reason}, both`).toEqual([
                { start: at('HEADER1'), end: at('\n> a quote'), printedAs: notRebuilt },
                { start: at('> a quote'), end: at('HEADER2'), printedAs: notRebuilt },
            ]);
        }
    });

    it('a refused forward whose only text is a folded `>` quote right above the next forward header: the first header left out, the second and its text printed (review round 3 of task 9.9b-1)', () =>
    {
        const made = make([file('Fwd: Desk invoice', LONE_OVER_A_QUOTE_THEN_FORWARD)], MODES[0]);
        expect(made.result.reconstructed).toEqual([]);
        const { cut, kept } = expectPdfFoldsAsPreview(made, 0, 'quote then forward');
        expect(cut).toBeGreaterThan(100);
        expect(kept).toBeGreaterThan(20);
        expect(expectHeaderLinesAboveText(made, 0, 'quote then forward')).toBe(1);
        const pdfText = squash(bodyOf(made.pdf.emails[0]!));
        expect(pdfText).not.toContain('the front desk');
        expect(pdfText).not.toContain('sometime in April');
        expect(pdfText).not.toContain('twelve oak desks');
        expect(pdfText.endsWith('From: the accounting team Date: sometime in March Subject: Desk invoice Short note.')).toBe(true);
    });

    it('a refused forward whose header lines, text and next header lines another file quotes: the first header left out, the second and its text printed (review round 3 of task 9.9b-1)', () =>
    {
        const earlierMs = Date.UTC(2025, 2, 4, 9, 0);
        const earlierDate = { utcMs: earlierMs, original: new Date(earlierMs).toUTCString(), offsetMinutes: 0, zoneKnown: true };
        // The other file quotes both headers (the second one's lines then follow a folded overlap piece that is not
        // header lines), or only the first header and its text (control: a shown blank line before the second).
        for (const [name, earlierBody, secondReasons] of [
            ['both headers quoted', OVERLAP_EARLIER, ['quoted-overlap', 'reply-header']],
            ['only the first header quoted (control)', OVERLAP_EARLIER_FIRST_ONLY, ['reply-header']],
        ] as const)
        {
            const earlier: NormalizedMessage = { ...file('Fwd: Desk invoice', earlierBody, 2), date: earlierDate };
            for (const mode of MODES.slice(0, 2))
            {
                const where = `${name}, ${mode.name}`;
                const made = make([file('Fwd: Desk invoice', OVERLAP_LATER), earlier], mode);
                expect(made.result.reconstructed, where).toEqual([]);
                const position = made.result.messages.findIndex((m) => m.message.source.fileName === 'lone-headers-1.eml');
                const body = made.result.messages[position]!.message.bodyText;
                const second = body.indexOf('---------- Forwarded message ---------\nFrom: the accounting team');
                expect(made.result.messages[position]!.segments.find((s) => s.start === second)?.reasons, where).toEqual(secondReasons);
                const { cut, kept } = expectPdfFoldsAsPreview(made, position, where);
                expect(cut, where).toBeGreaterThan(100);
                expect(kept, where).toBeGreaterThan(20);
                expect(expectHeaderLinesAboveText(made, position, where), where).toBe(1);
                expect(squash(bodyOf(made.pdf.emails.find((e) => e.position === position && e.rebuilt === null)!)), where)
                    .toBe('Hi Carol, See the invoice note below. Alice ---------- Forwarded message --------- From: the accounting team Date: sometime in March Subject: Desk invoice Short note.');
            }
        }
    });
});

/**
 * The general rule (user decisions Q2, Q3 and Q6, 2026-11-21): the preview's label of every block of the email at
 * `position` states truthfully whether each non-blank character is in the PDF (a shown block has no label: in).
 * Returns how many folded non-blank characters are labelled "In the PDF".
 */
function expectLabelsTruthful(made: Made, position: number, where: string): number
{
    const body = made.result.messages[position]!.message.bodyText;
    const printed = printedChars(made, position);
    let foldedIn = 0;
    for (const { block, label } of previewBlocks(made, position))
    {
        for (let i = block.start; i < block.end; i++)
        {
            if (!/\S/u.test(body[i]!))
            {
                continue;
            }
            const status = label?.status ?? 'in';
            expect(status, `${where}: "${squash(block.text).slice(0, 50)}" at ${String(i)}`).toBe(printed[i] === 1 ? 'in' : 'out');
            foldedIn += block.folded && status === 'in' ? 1 : 0;
        }
    }
    return foldedIn;
}

// Q6: a forward whose writer quotes an earlier email in their own text with a quote the tool cannot rebuild (a '>' quote
// with no header line): the plan keeps it as the writer's own ('writer-quote'), the preview folds it.
const WRITER_QUOTE_IN_A_FORWARD =
    'Hi Carol,\n\nAs I wrote last week:\n\n> The desks are late by two weeks.\n> Please plan for it.\n\nSee the forward below.\n\nAlice\n\n' +
    '---------- Forwarded message ---------\nFrom: Bob Sample <bob@example.test>\nDate: Tue, 4 Mar 2025 at 09:00\nSubject: Desk invoice\nTo: Alice Example <alice@example.test>\n\n' +
    'The invoice for the twelve oak desks is attached.\n\nBob\n';

describe('Q2 and Q6: a folded piece the PDF prints is labelled "In the PDF" (user decisions 2026-11-21)', () =>
{
    it('Q6: a writer\'s own quote in a forward is folded in the preview, printed in the PDF and labelled so, in every mode', () =>
    {
        const message = file('Fwd: Desk invoice', WRITER_QUOTE_IN_A_FORWARD);
        for (const mode of MODES)
        {
            const made = make([message], mode);
            const plan = made.plans[0]!;
            const quoteAt = WRITER_QUOTE_IN_A_FORWARD.indexOf('> The desks');
            expect(plan.ranges.find((r) => r.start <= quoteAt && quoteAt < r.end), mode.name).toMatchObject({ keep: true, reason: 'writer-quote' });
            const block = previewBlocks(made, 0).find((b) => b.block.start <= quoteAt && quoteAt < b.block.end)!;
            expect(block.block.folded, mode.name).toBe(true);
            expect(block.label, mode.name).toMatchObject({ status: 'in', reasons: ['writer-quote'] });
            expect(squash(bodyOf(made.pdf.emails.find((e) => e.position === 0)!)), mode.name).toContain('The desks are late by two weeks. Please plan for it.');
            expect(expectLabelsTruthful(made, 0, `writer quote, ${mode.name}`), mode.name).toBeGreaterThan(40);
        }
    });

    it('Q2: rebuilding off, a forward\'s folded header lines are printed and labelled "In the PDF: forwarded email"', () =>
    {
        const made = make([file('Fwd: Desk invoice', WRITER_QUOTE_IN_A_FORWARD)], MODES[2]);
        const headerAt = WRITER_QUOTE_IN_A_FORWARD.indexOf('---------- Forwarded');
        const block = previewBlocks(made, 0).find((b) => b.block.start <= headerAt && headerAt < b.block.end)!;
        expect(block.block.folded).toBe(true);
        expect(block.label).toMatchObject({ status: 'in', reasons: ['forwarded'] });
        expect(squash(bodyOf(made.pdf.emails[0]!))).toContain('From: Bob Sample <bob@example.test>');
        expect(expectLabelsTruthful(made, 0, 'rebuilding off')).toBeGreaterThan(100);
    });
});

describe('Q3 on every fixture: forwarded text the PDF prints outside a rebuilt email keeps its header lines (review round 1 of task 9.9b-1)', () =>
{
    it('every fixture alone and all together, every default mode: every preview label says what the PDF prints, header lines above printed text', async () =>
    {
        const messages = await parseAllFixtures();
        let headersChecked = 0;
        let bodiesChecked = 0;
        let foldedInChecked = 0;
        for (const group of [...messages.map((m) => [m]), messages])
        {
            for (const mode of MODES)
            {
                const made = make(group, mode);
                for (const position of made.positions)
                {
                    const plan = made.plans[made.positions.indexOf(position)]!;
                    const inPdf = made.pdf.emails.some((e) => e.position === position && e.rebuilt === null);
                    const where = `${group.length === 1 ? group[0]!.source.fileName : 'all fixtures'}, ${mode.name}, #${String(position + 1)}`;
                    if (inPdf && !plan.fallback)
                    {
                        foldedInChecked += expectLabelsTruthful(made, position, where);
                    }
                    if (!inPdf || plan.fallback || !plan.ranges.some((r) => r.reason === 'forwarded'))
                    {
                        continue;
                    }
                    expectPdfFoldsAsPreview(made, position, where);
                    headersChecked += expectHeaderLinesAboveText(made, position, where);
                    bodiesChecked++;
                }
            }
        }
        // 8 bodies with a forwarded part in the PDF (fixtures alone, then all together), in 3 modes. None prints forwarded text outside a rebuilt
        // email under header lines today (every such forward is rebuilt); the synthetic cases above do.
        expect(bodiesChecked).toBe(24);
        expect(headersChecked).toBe(0);
        // Folded text the PDF prints (kept signatures, writer quotes, forwards with rebuilding off) is labelled "In the PDF".
        expect(foldedInChecked).toBeGreaterThan(1000);
    }, 120_000);
});

describe('F6 with an attached email (.eml, whole pipeline, rebuilding on): the attached email\'s block is never a not-rebuilt piece', () =>
{
    const crlf = (...lines: string[]): string => lines.join('\r\n');
    const attachedEmail = crlf(
        'From: Bob Sample <bob@example.test>',
        'To: Alice Example <alice@example.test>',
        'Date: Mon, 3 Mar 2025 08:00:00 +0100',
        'Subject: Desk delivery',
        'Message-ID: <attached-delivery@example.test>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'The twelve oak desks leave the workshop on Thursday morning.',
        '',
        'Bob',
    );
    const holder = crlf(
        'From: Alice Example <alice@example.test>',
        'To: Carol Sample <carol@example.test>',
        'Date: Wed, 5 Mar 2025 09:00:00 +0100',
        'Subject: Fwd: Desk invoice',
        'Message-ID: <holder-invoice@example.test>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="holder-b"',
        '',
        '--holder-b',
        'Content-Type: text/plain; charset=utf-8',
        '',
        REFUSED_OVER_A_QUOTE.replace(/\n/gu, '\r\n'),
        '--holder-b',
        'Content-Type: message/rfc822',
        '',
        attachedEmail,
        '--holder-b--',
        '',
    );

    it('the refused forward over a quote is folded; the attached email is printed as its own email, its block cut as printed elsewhere', async () =>
    {
        const { createEmlParser } = await import('../email-reading/eml-parser');
        const parser = createEmlParser({ htmlToText: () => ({ text: '[stub html-to-text]', truncated: false }) });
        const parsed = await parser.parse({ name: 'holder.eml', bytes: new TextEncoder().encode(holder) });
        expect(parsed.ok).toBe(true);
        if (!parsed.ok)
        {
            return;
        }
        const made = makeFrom([parsed], MODES[0]);
        const holderAt = made.result.messages.findIndex((m) => m.message.subject === 'Fwd: Desk invoice');
        const body = made.result.messages[holderAt]!.message.bodyText;
        const separatorAt = body.indexOf(FORWARDED_SEPARATOR);
        // The .eml reader wrote the attached email's block under the holder's text, after the refused forward.
        expect(separatorAt).toBeGreaterThan(body.indexOf('From: the accounting team'));
        const { parts } = applyNoRepeatRule(made.input);
        const holderParts = parts.get(holderAt) ?? [];
        // F6 cuts the refused forward and its quote, all of it above the attached email's block.
        const notRebuilt = holderParts.filter((p) => p.printedAs?.kind === 'not-rebuilt');
        expect(notRebuilt.length).toBeGreaterThan(0);
        expect(notRebuilt.every((p) => p.end <= separatorAt)).toBe(true);
        // The block itself is left out because the attached email is printed on its own ("printed as" it).
        expect(holderParts.filter((p) => p.end > separatorAt).every((p) => p.printedAs?.kind === 'email')).toBe(true);
        expect(holderParts.some((p) => p.end > separatorAt)).toBe(true);
        const holderPdf = made.pdf.emails.find((e) => e.position === holderAt)!;
        expect(squash(bodyOf(holderPdf))).toBe('Hi Carol, See the invoice note below. Alice');
        expect(made.pdf.emails.filter((e) => squash(bodyOf(e)).includes('The twelve oak desks leave the workshop'))).toHaveLength(1);
        expectPdfFoldsAsPreview(made, holderAt, 'holder with an attached email');
    });
});

describe('F6 when unsure: a rebuilt place with malformed bounds turns F6 off for that body (review round 1 of task 9.9b-1)', () =>
{
    it('a place whose bounds are not whole numbers: nothing of that body is cut as not rebuilt', () =>
    {
        const made = make([file('Fwd: Desk invoice', REFUSED_OVER_A_QUOTE)], MODES[0]);
        const input = { ...made.input, rebuilt: [], unticked: [] };
        expect(applyNoRepeatRule(input).parts.get(0)?.some((p) => p.printedAs?.kind === 'not-rebuilt')).toBe(true);
        // A place taken from another body (any valid entry), moved to this body with bounds that cannot be trusted.
        const other = make([file('Fwd: Fwd: Desk order', EMPTY_FORWARD_AT_TOP)], MODES[0]).result.reconstructed[0]!;
        const sourceIndex = made.result.messages[0]!.index;
        for (const start of [0.5, Number.NaN, -1])
        {
            const unsure = { ...other, id: 0, sourceIndex, link: 'entry' as const, sameAs: null, rebuilt: { ...other.rebuilt, start } };
            const result = { ...made.result, reconstructed: [unsure] };
            expect(applyNoRepeatRule({ ...input, result }).parts.get(0)?.some((p) => p.printedAs?.kind === 'not-rebuilt') ?? false, String(start)).toBe(false);
        }
    });
});
