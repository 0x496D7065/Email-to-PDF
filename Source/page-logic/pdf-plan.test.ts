// Unit tests for the preview's PDF labels (pdf-plan.ts): exact cases of the
// mapping (cuts, whitespace, the shown-text safety label, "same signature as
// in email #N"), and every synthetic fixture through the real engine and the
// real plan, checking the two promises: no label is ever wrong for any of
// its text, and the blocks always give the body back unchanged (README.md,
// rule R6).

import { describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all';
import { runEngine, type EngineMessage } from '../thread-analysis/engine';
import { DEFAULT_OUTPUT_POLICY, planOutput, type MessagePlan, type PlanRange } from '../thread-analysis/output-plan';
import { buildSegments, type FoldRange, type FoldReason } from '../thread-analysis/segments';
import type { EmailAddress, NormalizedMessage, ParseResult } from '../email-reading/types';
import { displayBlocks } from './display-blocks';
import type { PdfRange } from '../pdf-export/model';
import { labelOf, mergeSamePrintedAs, pdfBlocks, pdfBreaks, printedAsEmailOfItsOwn, signatureSources, viewKey, type PdfBlock, type PdfLabel, type PdfView, type PrintedAs } from './pdf-plan';

const plan = (ranges: PlanRange[], extra: Partial<MessagePlan> = {}): MessagePlan => ({
    ranges,
    tailStart: null,
    omittedSignatures: 0,
    keptAllBecauseEmpty: false,
    fallback: false,
    ...extra,
});
const view = (ranges: PlanRange[], signatureFrom = new Map<number, number>()): PdfView => ({ plan: plan(ranges), signatureFrom });
const brief = (blocks: readonly PdfBlock[]) => blocks.map((b) => [b.block.text, b.block.folded, b.label?.status ?? null, b.label?.reasons ?? null]);

// Own text, a signature, one blank line, then an app quote: as Bob's
// Outlook reply in the fixtures. displayBlocks makes ONE folded block of
// the signature and the quote (the blank line is absorbed).
const OWN = 'Hello Alice,\nWednesday works.\n\n';
const SIG = '-- \nBob Sample\n';
const GAP = '\n';
const QUOTE = 'From: Alice Example\nSent: Monday\n\nHi Bob, a quote please.\n';
const BODY = OWN + SIG + GAP + QUOTE;
const A = OWN.length;
const B = A + SIG.length;
const C = B + GAP.length;
const SEGMENTS = buildSegments(BODY, [
    { start: A, end: B, reason: 'signature' },
    { start: C, end: BODY.length, reason: 'reply-header' },
] satisfies FoldRange[]);

describe('pdfBreaks', () =>
{
    it('cuts where kept and left-out text meet; whitespace never cuts', () =>
    {
        const ranges: PlanRange[] = [
            { start: 0, end: A, keep: true, reason: 'text' },
            { start: A, end: B, keep: true, reason: 'signature' },
            { start: B, end: C, keep: true, reason: 'text' },
            { start: C, end: BODY.length, keep: false, reason: 'app-quoted-history' },
        ];
        expect(pdfBreaks(BODY, ranges)).toEqual([C]);
        // A left-out whitespace range between two kept ones: no cut.
        expect(
            pdfBreaks('ab \n cd', [
                { start: 0, end: 2, keep: true, reason: 'text' },
                { start: 2, end: 5, keep: false, reason: 'app-quoted-history' },
                { start: 5, end: 7, keep: true, reason: 'writer-quote' },
            ]),
        ).toEqual([]);
        expect(pdfBreaks('', [])).toEqual([]);
    });
});

describe('pdfBlocks', () =>
{
    it('without a view: the plain display blocks, no labels', () =>
    {
        const blocks = pdfBlocks(BODY, SEGMENTS, null);
        expect(blocks.map((b) => b.block)).toEqual(displayBlocks(BODY, SEGMENTS, { unfoldAll: false }));
        expect(blocks.every((b) => b.label === null)).toBe(true);
        expect(brief(blocks)).toEqual([
            [OWN, false, null, null],
            [SIG + GAP + QUOTE, true, null, null],
        ]);
    });

    it('cuts a folded block whose text is partly kept, so each label is right for all of it', () =>
    {
        const v = view([
            { start: 0, end: A, keep: true, reason: 'text' },
            { start: A, end: B, keep: true, reason: 'signature' },
            { start: B, end: C, keep: true, reason: 'text' },
            { start: C, end: BODY.length, keep: false, reason: 'app-quoted-history' },
        ]);
        const blocks = pdfBlocks(BODY, SEGMENTS, v);
        expect(brief(blocks)).toEqual([
            [OWN, false, null, null],
            [SIG + GAP, true, 'in', ['signature']],
            [QUOTE, true, 'out', ['app-quoted-history']],
        ]);
        expect(blocks.map((b) => b.block.text).join('')).toBe(BODY);
        // Each part keeps the fold's own reasons (for its "Signature" / "Quoted" label).
        expect(blocks[1]?.block.label).toBe('signature');
        expect(blocks[2]?.block.label).toBe('reply-header');
    });

    it('does not cut when the whole folded block is left out; the label lists every reason', () =>
    {
        const v = view(
            [
                { start: 0, end: A, keep: true, reason: 'text' },
                { start: A, end: B, keep: false, reason: 'repeated-signature' },
                { start: B, end: C, keep: true, reason: 'text' },
                { start: C, end: BODY.length, keep: false, reason: 'app-quoted-history' },
            ],
            new Map([[A, 2]]),
        );
        const blocks = pdfBlocks(BODY, SEGMENTS, v);
        expect(brief(blocks)).toEqual([
            [OWN, false, null, null],
            [SIG + GAP + QUOTE, true, 'out', ['repeated-signature', 'app-quoted-history']],
        ]);
        expect(blocks[1]?.label?.signaturesFrom).toEqual([2]);
    });

    it('with "Print full original text", every folded block is "in"', () =>
    {
        const v = view([
            { start: 0, end: A, keep: true, reason: 'text' },
            { start: A, end: B, keep: true, reason: 'repeated-signature' },
            { start: B, end: C, keep: true, reason: 'text' },
            { start: C, end: BODY.length, keep: true, reason: 'app-quoted-history' },
        ]);
        expect(brief(pdfBlocks(BODY, SEGMENTS, v))).toEqual([
            [OWN, false, null, null],
            [SIG + GAP + QUOTE, true, 'in', ['repeated-signature', 'app-quoted-history']],
        ]);
    });

    it('labels shown text the plan leaves out (a bug, never hidden)', () =>
    {
        const v = view([
            { start: 0, end: 5, keep: false, reason: 'app-quoted-history' },
            { start: 5, end: BODY.length, keep: true, reason: 'text' },
        ]);
        const blocks = pdfBlocks(BODY, SEGMENTS, v);
        expect(blocks[0]?.block.folded).toBe(false);
        expect(blocks[0]?.label?.status).toBe('out');
        expect(blocks.map((b) => b.block.text).join('')).toBe(BODY);
    });
});

describe('labelOf', () =>
{
    it('a whitespace-only part is labelled from all its ranges', () =>
    {
        const text = 'a\n\n\nb';
        const v = view([
            { start: 0, end: 1, keep: true, reason: 'text' },
            { start: 1, end: 4, keep: false, reason: 'app-quoted-history' },
            { start: 4, end: 5, keep: true, reason: 'text' },
        ]);
        expect(labelOf(text, 1, 4, v)).toEqual({ status: 'out', reasons: ['app-quoted-history'], signaturesFrom: [] });
        // Text and whitespace: only the text decides.
        expect(labelOf(text, 0, 4, v)).toEqual({ status: 'in', reasons: ['text'], signaturesFrom: [] });
        // Kept and left-out text together (never produced by pdfBlocks): "partly".
        expect(labelOf('ab', 0, 2, view([
            { start: 0, end: 1, keep: true, reason: 'text' },
            { start: 1, end: 2, keep: false, reason: 'app-quoted-history' },
        ])).status).toBe('partly');
    });

    it('lists every distinct email a block\'s repeated signatures come from, in order', () =>
    {
        const text = 'sig one\nsig two\nsig three\nsig four\n';
        const v = view(
            [
                { start: 0, end: 8, keep: false, reason: 'repeated-signature' },
                { start: 8, end: 16, keep: false, reason: 'repeated-signature' },
                { start: 16, end: 26, keep: false, reason: 'repeated-signature' },
                { start: 26, end: 35, keep: false, reason: 'repeated-signature' },
            ],
            // #3, then #1, then #3 again; the fourth has no known source.
            new Map([
                [0, 3],
                [8, 1],
                [16, 3],
            ]),
        );
        expect(labelOf(text, 0, text.length, v)).toEqual({ status: 'out', reasons: ['repeated-signature'], signaturesFrom: [1, 3] });
        // Only the ranges of the block count.
        expect(labelOf(text, 8, 16, v).signaturesFrom).toEqual([1]);
        expect(labelOf(text, 26, 35, v).signaturesFrom).toEqual([]);
    });
});

describe('viewKey', () =>
{
    it('changes with the ranges, the flags and the signature sources', () =>
    {
        const ranges: PlanRange[] = [{ start: 0, end: 3, keep: true, reason: 'text' }];
        const base = viewKey(view(ranges));
        expect(viewKey(null)).toBe('none');
        expect(viewKey(view(ranges))).toBe(base);
        expect(viewKey(view([{ start: 0, end: 3, keep: false, reason: 'text' }]))).not.toBe(base);
        expect(viewKey({ plan: plan(ranges, { keptAllBecauseEmpty: true }), signatureFrom: new Map() })).not.toBe(base);
        expect(viewKey({ plan: plan(ranges, { fallback: true }), signatureFrom: new Map() })).not.toBe(base);
        expect(viewKey(view(ranges, new Map([[0, 1]])))).not.toBe(base);
    });
});

describe('a view with the PDF\'s ranges (the no-repeat rule, task 8.11)', () =>
{
    // The quote is kept by the plan (say a forwarded part); the PDF prints its
    // header and its first paragraph as two different emails.
    const QUOTE_HEAD = 'From: Alice Example\nSent: Monday\n\n'.length;
    const PLAN: PlanRange[] = [
        { start: 0, end: A, keep: true, reason: 'text' },
        { start: A, end: B, keep: true, reason: 'signature' },
        { start: B, end: C, keep: true, reason: 'text' },
        { start: C, end: BODY.length, keep: true, reason: 'forwarded' },
    ];
    const REBUILT: PrintedAs = { kind: 'rebuilt', id: 4, number: 2 };
    const REAL: PrintedAs = { kind: 'email', position: 0, number: 1 };
    const cutView = (pieces: PdfRange[]): PdfView => ({ ...view(PLAN), pdfRanges: pieces });
    const pieces = (head: PrintedAs | null, rest: PrintedAs | null): PdfRange[] => [
        { start: 0, end: A, keep: true, reason: 'text', printedAs: null },
        { start: A, end: B, keep: true, reason: 'signature', printedAs: null },
        { start: B, end: C, keep: true, reason: 'text', printedAs: null },
        { start: C, end: C + QUOTE_HEAD, keep: head === null, reason: 'forwarded', printedAs: head },
        { start: C + QUOTE_HEAD, end: BODY.length, keep: rest === null, reason: 'forwarded', printedAs: rest },
    ];

    it('without PDF ranges, the plan\'s ranges as before ("In the PDF: forwarded email")', () =>
    {
        expect(brief(pdfBlocks(BODY, SEGMENTS, view(PLAN)))).toEqual([
            [OWN, false, null, null],
            [SIG + GAP + QUOTE, true, 'in', ['signature', 'forwarded']],
        ]);
    });

    it('a part printed as an email of its own is "out" with that email, cut from what stays', () =>
    {
        const blocks = pdfBlocks(BODY, SEGMENTS, cutView(pieces(REBUILT, REBUILT)));
        expect(brief(blocks)).toEqual([
            [OWN, false, null, null],
            [SIG + GAP, true, 'in', ['signature']],
            [QUOTE, true, 'out', ['forwarded']],
        ]);
        expect(blocks[1]?.label?.printedAs ?? null).toBeNull();
        expect(blocks[2]?.label?.printedAs).toEqual(REBUILT);
        expect(blocks.map((b) => b.block.text).join('')).toBe(BODY);
    });

    it('a block is cut where the email it is printed as changes; a part the PDF keeps stays "in"', () =>
    {
        const two = pdfBlocks(BODY, SEGMENTS, cutView(pieces(REAL, REBUILT)));
        expect(two.map((b) => [b.block.text, b.label?.status ?? null, b.label?.printedAs ?? null])).toEqual([
            [OWN, null, null],
            [SIG + GAP, 'in', null],
            [QUOTE.slice(0, QUOTE_HEAD), 'out', REAL],
            [QUOTE.slice(QUOTE_HEAD), 'out', REBUILT],
        ]);
        // Header lines kept (B2), the text printed elsewhere.
        const kept = pdfBlocks(BODY, SEGMENTS, cutView(pieces(null, REBUILT)));
        expect(kept.map((b) => [b.block.text, b.label?.status ?? null, b.label?.printedAs ?? null])).toEqual([
            [OWN, null, null],
            [SIG + GAP + QUOTE.slice(0, QUOTE_HEAD), 'in', null],
            [QUOTE.slice(QUOTE_HEAD), 'out', REBUILT],
        ]);
    });

    it('a block left out by the plan next to one printed elsewhere: two blocks, each with its own label', () =>
    {
        const v: PdfView = {
            ...view(PLAN),
            pdfRanges: [
                ...pieces(null, null).slice(0, 3),
                { start: C, end: C + QUOTE_HEAD, keep: false, reason: 'app-quoted-history', printedAs: null },
                { start: C + QUOTE_HEAD, end: BODY.length, keep: false, reason: 'forwarded', printedAs: REAL },
            ],
        };
        const blocks = pdfBlocks(BODY, SEGMENTS, v);
        expect(blocks.slice(-2).map((b) => [b.block.text, b.label?.status ?? null, b.label?.reasons ?? null, b.label?.printedAs ?? null])).toEqual([
            [QUOTE.slice(0, QUOTE_HEAD), 'out', ['app-quoted-history'], null],
            [QUOTE.slice(QUOTE_HEAD), 'out', ['forwarded'], REAL],
        ]);
    });

    it('labelOf names the email only when all of the block\'s text is printed as that one email', () =>
    {
        const v = cutView(pieces(REAL, REBUILT));
        expect(labelOf(BODY, C + QUOTE_HEAD, BODY.length, v).printedAs).toEqual(REBUILT);
        // Two emails in one span (never produced by pdfBlocks): no email named.
        expect(labelOf(BODY, C, BODY.length, v)).toEqual({ status: 'out', reasons: ['forwarded'], signaturesFrom: [] });
    });

    it('viewKey changes with the PDF ranges and the email named', () =>
    {
        const base = viewKey(view(PLAN));
        const a = viewKey(cutView(pieces(REBUILT, REBUILT)));
        expect(a).not.toBe(base);
        expect(viewKey(cutView(pieces(REAL, REBUILT)))).not.toBe(a);
        expect(viewKey(cutView(pieces(REBUILT, { ...REBUILT, number: 3 })))).not.toBe(a);
        expect(viewKey(cutView(pieces(REBUILT, REBUILT)))).toBe(a);
    });
});

// ------------------------------------------------------------ real engine

const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.test' };
const BOB: EmailAddress = { name: 'Bob Sample', address: 'bob@example.test' };
let counter = 0;
function make(from: EmailAddress, bodyText: string): NormalizedMessage
{
    counter++;
    return {
        messageId: `pp${String(counter)}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: Date.parse('2025-03-03T08:15:00Z') + counter * 3_600_000, original: 'synthetic', offsetMinutes: 0, zoneKnown: true },
        from: [from],
        to: [],
        cc: [],
        bcc: [],
        subject: `Bench ${String(counter)}`,
        bodyText,
        attachments: [],
        source: { fileName: `pp-${String(counter)}.eml`, sha256: (1000 + counter).toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
    };
}
const SIGNATURE = '\n-- \nAlice Example\nGarden Benches (fictional company)\n';
const engineOf = (messages: readonly NormalizedMessage[]) => runEngine(messages.map((message): ParseResult => ({ ok: true, message })));

describe('signatureSources', () =>
{
    it('points a repeated signature to the email where it is kept, as the plan decides', () =>
    {
        const r = engineOf([
            make(ALICE, `The bench is green.\n${SIGNATURE}`),
            make(BOB, 'Thanks, noted.\n'),
            make(ALICE, `The bench is delivered.\n${SIGNATURE}`),
            make(ALICE, `The invoice follows.\n${SIGNATURE}`),
        ]);
        const all = r.messages.map((m, position) => ({ message: m.message, position }));
        const plans = planOutput(r.messages);
        const repeated = (k: number) => plans[k]?.ranges.find((range) => range.reason === 'repeated-signature');
        expect(repeated(2)?.keep).toBe(false);
        const sources = signatureSources(all, plans);
        expect(sources.get(2)?.get(repeated(2)?.start ?? -1)).toBe(1);
        expect(sources.get(3)?.get(repeated(3)?.start ?? -1)).toBe(1);
        expect(sources.has(0)).toBe(false);

        // Without the first email (as when it is unticked), the third keeps it, the fourth points there.
        const some = [1, 2, 3].map((position) => ({ message: r.messages[position]!.message, position }));
        const fewer = planOutput([1, 2, 3].map((p) => r.messages[p]!));
        expect(fewer[1]?.ranges.some((range) => range.reason === 'signature' && range.keep)).toBe(true);
        const fewerSources = signatureSources(some, fewer);
        expect(fewerSources.has(2)).toBe(false);
        const fourth = fewer[2]?.ranges.find((range) => range.reason === 'repeated-signature');
        expect(fewerSources.get(3)?.get(fourth?.start ?? -1)).toBe(3);
    });
});

/** For every block: each non-space character of it is kept exactly when its label says "in". */
function expectLabelsTrue(m: EngineMessage, p: MessagePlan, blocks: readonly PdfBlock[]): void
{
    const body = m.message.bodyText;
    const keep = new Array<boolean>(body.length).fill(true);
    for (const r of p.ranges)
    {
        for (let i = r.start; i < r.end; i++)
        {
            keep[i] = r.keep;
        }
    }
    for (const { block, label } of blocks)
    {
        const where = `${m.message.source.fileName} [${String(block.start)}, ${String(block.end)})`;
        if (block.folded)
        {
            expect(label, where).not.toBeNull();
        }
        expect(label?.status, where).not.toBe('partly');
        for (let i = block.start; i < block.end; i++)
        {
            if (!/\S/.test(body[i] ?? ''))
            {
                continue;
            }
            if (label === null)
            {
                expect(keep[i], `${where} at ${String(i)}: shown, no label, but left out`).toBe(true);
            }
            else
            {
                expect(keep[i], `${where} at ${String(i)}`).toBe(label.status === 'in');
            }
        }
    }
}

describe('every fixture, through the real engine and plan', () =>
{
    it('labels are never wrong, shown text is never left out, and the blocks give the body back', async () =>
    {
        const parsed = await parseAllFixtures();
        const r = runEngine(parsed.map((message): ParseResult => ({ ok: true, message })));
        const all = r.messages.map((m, position) => ({ message: m.message, position }));
        for (const policy of [DEFAULT_OUTPUT_POLICY, { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true }])
        {
            const plans = planOutput(r.messages, policy);
            const sources = signatureSources(all, plans);
            let cut = 0;
            let repeatedWithSource = 0;
            r.messages.forEach((m, k) =>
            {
                const p = plans[k]!;
                const blocks = pdfBlocks(m.message.bodyText, m.segments, { plan: p, signatureFrom: sources.get(k) ?? new Map() });
                expect(blocks.map((b) => b.block.text).join('')).toBe(m.message.bodyText);
                expectLabelsTrue(m, p, blocks);
                // Shown text is never left out (output-plan.ts, rule 4): no shown block carries a label.
                expect(blocks.filter((b) => !b.block.folded && b.label !== null)).toEqual([]);
                if (policy.unfoldEverything)
                {
                    expect(blocks.every((b) => b.label === null || b.label.status === 'in')).toBe(true);
                }
                cut += blocks.length - displayBlocks(m.message.bodyText, m.segments, { unfoldAll: false }).length;
                for (const b of blocks)
                {
                    if (b.label?.reasons.includes('repeated-signature') === true && b.label.signaturesFrom.length > 0)
                    {
                        repeatedWithSource++;
                    }
                }
            });
            if (!policy.unfoldEverything)
            {
                // The fixtures have a kept signature right above a left-out quote (cut in two), and repeated signatures.
                expect(cut).toBeGreaterThan(0);
                expect(repeatedWithSource).toBeGreaterThan(5);
            }
        }
    });
});

describe('printedAsEmailOfItsOwn (task 8.11, S1, done in task 8.13a)', () =>
{
    const body = 'Own text.\nFrom: x\nQuoted text.\n\n';
    // 32 characters: 'Own text.\n' [0, 10), 'From: x\n' [10, 18), 'Quoted text.' [18, 30), then white space alone [30, 32).
    const range = (start: number, end: number, printedAs: PrintedAs | null): PdfRange => ({ start, end, keep: printedAs === null, reason: 'forwarded', printedAs });

    it('is true when text is left out because it is printed as a rebuilt or a real email', () =>
    {
        expect(body).toHaveLength(32);
        expect(printedAsEmailOfItsOwn({ pdfRanges: [range(0, 10, null), range(10, 32, { kind: 'rebuilt', id: 0, number: 1 })] }, body)).toBe(true);
        expect(printedAsEmailOfItsOwn({ pdfRanges: [range(0, 10, null), range(10, 32, { kind: 'email', position: 1, number: 2 })] }, body)).toBe(true);
    });

    it('is false for an unticked forwarded part (printed nowhere), white space alone, no cut, or no view', () =>
    {
        expect(printedAsEmailOfItsOwn({ pdfRanges: [range(0, 10, null), range(10, 32, { kind: 'unticked', id: 0 })] }, body)).toBe(false);
        expect(printedAsEmailOfItsOwn({ pdfRanges: [range(0, 30, null), range(30, 32, { kind: 'rebuilt', id: 0, number: 1 })] }, body)).toBe(false);
        expect(printedAsEmailOfItsOwn({ pdfRanges: [range(0, 32, null)] }, body)).toBe(false);
        expect(printedAsEmailOfItsOwn({}, body)).toBe(false);
        expect(printedAsEmailOfItsOwn(null, body)).toBe(false);
    });
});

describe('adjacent blocks with the same "printed as" label are one block (task 8.13a review round 2)', () =>
{
    // A forward: own text, then the forwarded email's header lines (folded) and its text (shown), as the e2e forward.
    const OWN_TEXT = 'Bob, see below.\n\n';
    const HEADER = '---------- Forwarded message ---------\nFrom: Depot Desk <depot@example.test>\nDate: Fri, 21 Mar 2025 at 09:00\n\n';
    const TEXT = 'The delivery slot is Tuesday morning.\n';
    const WS = '\n\n';
    const FWD = OWN_TEXT + HEADER + TEXT;
    const H = OWN_TEXT.length;
    const T = H + HEADER.length;
    const fwdSegments = buildSegments(FWD, [{ start: H, end: T, reason: 'reply-header' }] satisfies FoldRange[]);
    const cutView = (pieces: readonly [number, number, PrintedAs | null][], body = FWD): PdfView =>
    {
        const ranges: PdfRange[] = pieces.map(([start, end, printedAs]) => ({ start, end, keep: printedAs === null, reason: start === 0 ? 'text' : 'forwarded', printedAs }));
        return { plan: plan([{ start: 0, end: H, keep: true, reason: 'text' }, { start: H, end: body.length, keep: true, reason: 'forwarded' }]), signatureFrom: new Map(), pdfRanges: ranges };
    };
    const rebuilt5: PrintedAs = { kind: 'rebuilt', id: 0, number: 5 };

    it('the header lines (folded) and the text (shown) printed as the same email: one SHOWN block, one label; the body comes back whole', () =>
    {
        // Two ranges (as the PDF cut gives them when the header lines and the text are cut apart), one email.
        const v = cutView([
            [0, H, null],
            [H, T, rebuilt5],
            [T, FWD.length, rebuilt5],
        ]);
        // Without the merge the display blocks are two: the folded header, the shown text.
        expect(displayBlocks(FWD, fwdSegments, { unfoldAll: false, breaks: pdfBreaks(FWD, v.pdfRanges!) }).map((b) => b.folded)).toEqual([false, true, false]);
        const blocks = pdfBlocks(FWD, fwdSegments, v);
        expect(blocks.map((b) => [b.block.start, b.block.end, b.block.folded, b.label?.printedAs ?? null])).toEqual([
            [0, H, false, null],
            [H, FWD.length, false, rebuilt5],
        ]);
        expect(blocks[1]!.label).toEqual({ status: 'out', reasons: ['forwarded'], signaturesFrom: [], printedAs: rebuilt5 });
        // Folded + shown -> shown (user decision, option (a)): the header lines are visible.
        expect(blocks[1]!.block).toMatchObject({ reasons: [], related: [], label: null, collapsed: false, text: HEADER + TEXT });
        // Collapse, never delete (R6).
        expect(blocks.map((b) => b.block.text).join('')).toBe(FWD);
    });

    // The merge itself, on hand-made blocks (two folded blocks with the same
    // "printed as" are already one display block, so this case is not reached
    // through pdfBlocks; the rule is checked directly).
    const outLabel = (printedAs: PrintedAs): PdfLabel => ({ status: 'out', reasons: ['forwarded'], signaturesFrom: [], printedAs });
    const blk = (start: number, end: number, folded: boolean, reason: FoldReason | null, related: number[] = []): PdfBlock => ({
        block: { start, end, text: FWD.slice(start, end), folded, reasons: reason === null ? [] : [reason], related, label: reason, collapsed: folded },
        label: outLabel(rebuilt5),
    });

    it('merge rule: folded + folded -> folded (reasons and links joined, the longer one names it); folded + shown or shown + shown -> shown', () =>
    {
        const ff = mergeSamePrintedAs([blk(H, T, true, 'reply-header', [2]), blk(T, FWD.length, true, 'quote-marker', [1, 2])]);
        expect(ff).toHaveLength(1);
        // HEADER is longer than TEXT.
        expect(ff[0]!.block).toMatchObject({ start: H, end: FWD.length, folded: true, collapsed: true, related: [1, 2], label: 'reply-header', text: FWD.slice(H) });
        expect([...ff[0]!.block.reasons].sort()).toEqual(['quote-marker', 'reply-header']);
        for (const [a, b] of [
            [true, false],
            [false, true],
            [false, false],
        ] as const)
        {
            const m = mergeSamePrintedAs([blk(H, T, a, a ? 'reply-header' : null), blk(T, FWD.length, b, b ? 'quote-marker' : null)]);
            expect(m).toHaveLength(1);
            expect(m[0]!.block).toMatchObject({ start: H, end: FWD.length, folded: false, collapsed: false, reasons: [], related: [], label: null });
            expect(m[0]!.label).toEqual(outLabel(rebuilt5));
            // R6: the joined text is exactly the body slice.
            expect(m[0]!.block.text).toBe(FWD.slice(H));
        }
    });

    it('also for a forwarded email whose rebuilt email is unticked (the same id)', () =>
    {
        const unticked: PrintedAs = { kind: 'unticked', id: 3 };
        const blocks = pdfBlocks(FWD, fwdSegments, cutView([[0, H, null], [H, T, unticked], [T, FWD.length, unticked]]));
        expect(blocks.map((b) => b.label?.printedAs ?? null)).toEqual([null, unticked]);
        expect(blocks.map((b) => b.block.text).join('')).toBe(FWD);
    });

    it('never for two different emails, two numbers, two unticked emails, or a block in between', () =>
    {
        const cases: [PrintedAs, PrintedAs][] = [
            [rebuilt5, { kind: 'rebuilt', id: 1, number: 6 }],
            [rebuilt5, { kind: 'rebuilt', id: 0, number: 6 }],
            [rebuilt5, { kind: 'email', position: 0, number: 5 }],
            [{ kind: 'unticked', id: 1 }, { kind: 'unticked', id: 2 }],
            [rebuilt5, { kind: 'unticked', id: 0 }],
        ];
        for (const [a, b] of cases)
        {
            const blocks = pdfBlocks(FWD, fwdSegments, cutView([[0, H, null], [H, T, a], [T, FWD.length, b]]));
            expect(blocks.map((x) => x.label?.printedAs ?? null)).toEqual([null, a, b]);
            expect(blocks.map((x) => x.block.text).join('')).toBe(FWD);
        }
        // A shown block between the two (text the PDF keeps: no label): they stay apart.
        const KEPT = 'A line the PDF keeps.\n';
        const body = OWN_TEXT + HEADER + KEPT + WS + TEXT;
        const K = T + KEPT.length;
        const blocks = pdfBlocks(body, buildSegments(body, [{ start: H, end: T, reason: 'reply-header' }] satisfies FoldRange[]), cutView([[0, H, null], [H, T, rebuilt5], [T, K, null], [K, body.length, rebuilt5]], body));
        expect(blocks.map((b) => b.block.text).join('')).toBe(body);
        expect(blocks.map((b) => [b.block.folded, b.label?.printedAs ?? null])).toEqual([
            [false, null],
            [true, rebuilt5],
            [false, null],
            [false, rebuilt5],
        ]);
        // Kept text and a left-out block side by side: never merged (only two 'out' labels are).
        const kept = pdfBlocks(FWD, fwdSegments, cutView([[0, H, null], [H, FWD.length, rebuilt5]]));
        expect(kept.map((b) => b.label?.status ?? null)).toEqual([null, 'out']);
    });
});
