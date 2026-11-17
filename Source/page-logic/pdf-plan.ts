// What the preview says about the PDF: for each folded block of an email,
// whether it will be in the PDF or not, and why. The decision itself is the
// PDF's own plan (planOutput, Source/thread-analysis/output-plan.ts), run on the same
// emails the PDF gets (the included ones, in list order, with the same
// policy): this file only maps a MessagePlan onto the preview's display
// blocks (Source/page-logic/display-blocks.ts). It decides nothing on its own.
//
// Rules:
// - A folded block is either all in the PDF or all left out. Where a plan's
//   kept and left-out ranges meet inside what would be one folded block (a
//   kept signature right above left-out quoted history), the block is cut
//   there (pdfBreaks), so no label ever covers both.
// - Whitespace does not count: a blank line is neither "in" nor "left out"
//   of the PDF in any way a reader could notice, so a whitespace-only range
//   never causes a cut and does not decide a label. It belongs to the block
//   above it. (A whitespace-only block is labelled from all its ranges.)
// - Shown (unfolded) text is never left out by the plan (rule 4 of
//   output-plan.ts). If a plan ever did, the shown block gets a "Not in the
//   PDF" label too rather than hiding the fact (a bug, never expected).
// - "Same signature as in email #N": the earliest email (in list order) of
//   the same sender whose plan KEEPS a signature range with the same
//   normalized text (the same key and sender functions the plan uses; one
//   signature range is one signature block of the plan). A block holding
//   several repeated signatures lists every distinct source ("#1, #3").
//   When none is found (not expected), the label just says "repeated
//   signature".
// - Printed as an email of its own (task 8.11): with "Print full original
//   text" off, the PDF also leaves out of a body the parts it prints as
//   emails of their own (the no-repeat rule of Source/pdf-export/model.ts, task
//   8.10). A view then carries the body's ranges as the PDF prints them
//   (`pdfRanges`, from Source/page-logic/printed-elsewhere.ts, which calls the
//   PDF model's own functions); they replace the plan's ranges here. Such
//   a piece is left out (status 'out') and carries the email it is printed
//   as (`printedAs`): the label says so instead of the plan's reasons. A
//   block is cut where that email changes, as where `keep` changes, so a
//   label never covers a part printed elsewhere and one that is not (or
//   two parts printed as two different emails). The same holds for a
//   forwarded part the PDF leaves out because its rebuilt email is
//   unticked (task 8.13a, Q2: `printedAs` kind 'unticked', printed
//   nowhere in the PDF), and for the printed block of an attached email
//   the reader unticked (task 8.13b-3, Q3: kind 'unticked-attached'; one
//   in the PDF is kind 'email', like a real file). Two ADJACENT blocks with the very same "printed
//   as" label (both left out, the same email and number, or the same
//   unticked email) are then joined into one block with one label
//   (mergeSamePrintedAs, task 8.13a review round 2): a forward's header
//   lines and its text, say, no longer show the label twice. The joined
//   block is folded only when both were, else shown.
//
// Collapse, never delete (README.md, rule R6): blocks only group and cut
// the body; their texts joined always give the body back unchanged.
//
// Pure functions, no DOM (README.md, rule R7).

import { FOLD_REASONS } from '../thread-analysis/segments';
import { senderKeyOf, signatureBlockKey } from '../thread-analysis/signature';
import { displayBlocks } from './display-blocks';
import type { MessagePlan, PlanRange } from '../../Header/output-plan';
import type { PrintedAs } from '../../Header/pdf-document-model';
import type { DisplayBlock, PdfBlock, PdfLabel, PdfStatus, PdfView, PlannedEmail } from '../../Header/pdf-plan';
import type { Segment } from '../../Header/thread-analysis-result';

/** A range for the labels: a plan range, or a PDF range (with `printedAs`). */
type LabelRange = PlanRange & { readonly printedAs?: PrintedAs | null };

/** The ranges the labels follow (see PdfView.pdfRanges). */
function rangesOf(view: PdfView): readonly LabelRange[]
{
    return view.pdfRanges ?? view.plan.ranges;
}

/** A short key of where a range is printed instead ('' when it is not left out that way). */
function printedKey(r: LabelRange): string
{
    return printedAsKey(r.printedAs);
}

/** A short key of a PrintedAs: the same kind, email and number give the same key ('' for none). */
function printedAsKey(p: PrintedAs | null | undefined): string
{
    if (p === null || p === undefined)
    {
        return '';
    }
    switch (p.kind)
    {
        case 'rebuilt':
            return `r${String(p.id)}#${String(p.number)}`;
        case 'email':
            return `e${String(p.position)}#${String(p.number)}`;
        case 'unticked':
            return `u${String(p.id)}`;
        case 'unticked-attached':
            return `a${String(p.position)}`;
    }
}

/**
 * Whether the PDF leaves text (not white space alone) of `body` out because
 * it prints it as an email of its own (a rebuilt email or a real file; not
 * an unticked forwarded part or unticked attached email, which is printed
 * nowhere): then the note of
 * an email kept whole says so (task 8.11, finding S1, done in task 8.13a;
 * Source/page-logic/message-notes.ts, pdfPlanNote). `view` null or without
 * `pdfRanges`: false.
 */
export function printedAsEmailOfItsOwn(view: Pick<PdfView, 'pdfRanges'> | null, body: string): boolean
{
    // 'unticked' never meets keptAllBecauseEmpty anyway: keepsKind always keeps 'forwarded', so a plan with a forwarded part with text is never "kept whole because empty".
    return (view?.pdfRanges ?? []).some(
        (r) => r.printedAs != null && r.printedAs.kind !== 'unticked' && r.printedAs.kind !== 'unticked-attached' && hasNonSpace(body, r.start, r.end),
    );
}

/** True if text[start, end) has a character that is not white space. */
export function hasNonSpace(text: string, start: number, end: number): boolean
{
    return /\S/.test(text.slice(start, end));
}

/**
 * Where the preview must start a new block: the start of each range with
 * text whose `keep`, or the email it is printed as (`printedAs`, see the
 * top), differs from the previous range with text. Whitespace ranges in
 * between stay with the block above.
 */
export function pdfBreaks(text: string, ranges: readonly LabelRange[]): number[]
{
    const breaks: number[] = [];
    let last: string | null = null;
    for (const r of ranges)
    {
        if (!hasNonSpace(text, r.start, r.end))
        {
            continue;
        }
        const key = `${r.keep ? '+' : '-'}${printedKey(r)}`;
        if (last !== null && key !== last)
        {
            breaks.push(r.start);
        }
        last = key;
    }
    return breaks;
}

/** The label of text[start, end) under `view` (see the rules at the top). */
export function labelOf(text: string, start: number, end: number, view: PdfView): PdfLabel
{
    const overlapping = rangesOf(view).filter((r) => r.start < end && r.end > start);
    const withText = overlapping.filter((r) => hasNonSpace(text, Math.max(r.start, start), Math.min(r.end, end)));
    const deciding = withText.length > 0 ? withText : overlapping;
    const kept = deciding.filter((r) => r.keep).length;
    const status: PdfStatus = kept === deciding.length ? 'in' : kept === 0 ? 'out' : 'partly';
    const reasons = [...new Set(deciding.map((r) => r.reason))];
    const from = new Set<number>();
    for (const r of deciding)
    {
        if (r.reason !== 'repeated-signature')
        {
            continue;
        }
        const n = view.signatureFrom.get(r.start);
        if (n !== undefined)
        {
            from.add(n);
        }
    }
    const label: PdfLabel = { status, reasons, signaturesFrom: [...from].sort((a, b) => a - b) };
    // Printed as an email of its own: only when every deciding range is, as the same email.
    const first = deciding[0];
    const printedAs = first?.printedAs ?? null;
    if (status === 'out' && printedAs !== null && deciding.every((r) => printedKey(r) === printedKey(first!)))
    {
        return { ...label, printedAs };
    }
    return label;
}

/**
 * The preview's blocks of one email, with their PDF labels. Without a view
 * (the email is not in the PDF, or the plan is not ready), the plain display
 * blocks with no labels.
 */
export function pdfBlocks(text: string, segments: readonly Segment[], view: PdfView | null): PdfBlock[]
{
    if (view === null)
    {
        return displayBlocks(text, segments, { unfoldAll: false }).map((block) => ({ block, label: null }));
    }
    const blocks = displayBlocks(text, segments, { unfoldAll: false, breaks: pdfBreaks(text, rangesOf(view)) });
    const labelled = blocks.map((block) =>
    {
        const label = labelOf(text, block.start, block.end, view);
        // A shown block is labelled only if the PDF leaves something of it out
        // (by the plan: a bug, see the top; or printed as an email of its own).
        return { block, label: block.folded || label.status !== 'in' ? label : null };
    });
    return mergeSamePrintedAs(labelled);
}

/** Whether two labels both say "left out, printed as" the very same email (or both "unticked", the same one). */
function samePrintedAsLabel(a: PdfLabel | null, b: PdfLabel | null): boolean
{
    if (a === null || b === null || a.status !== 'out' || b.status !== 'out')
    {
        return false;
    }
    const key = printedAsKey(a.printedAs);
    return key !== '' && key === printedAsKey(b.printedAs);
}

/**
 * Adjacent blocks whose labels are the same "printed as" label (see the top:
 * both left out, the same kind, email and number; samePrintedAsLabel) made
 * into ONE block with one label (user decision, task 8.13a review round 2:
 * a forward's header lines, a folded block, and its text, a shown one, used
 * to show "printed as Email 5" twice). Only directly adjacent blocks: a block
 * between them (even shown white space) keeps them apart. The merged block
 * is folded only when BOTH were (user decision, task 8.13a final round,
 * option (a)): then its reasons and links are the union of theirs and its
 * fold label that of the longer one. Otherwise it is shown (reasons, links
 * and fold label empty, as for any shown block), so header lines that were
 * folded become visible: e.g. a folded header [H,T) and a shown text [T,E)
 * give one shown block [H,E) with one label. Collapse, never delete (rule
 * R6): its text is the two texts joined, so the blocks still give the body
 * back unchanged.
 * Done here, in the preview's blocks only: the PDF and the no-repeat parts
 * (Source/pdf-export/model.ts, noRepeat) are not changed by it.
 */
export function mergeSamePrintedAs(blocks: readonly PdfBlock[]): PdfBlock[]
{
    const out: PdfBlock[] = [];
    for (const b of blocks)
    {
        const last = out[out.length - 1];
        if (last === undefined || last.block.end !== b.block.start || !samePrintedAsLabel(last.label, b.label))
        {
            out.push(b);
            continue;
        }
        const x = last.block;
        const y = b.block;
        const folded = x.folded && y.folded;
        const block: DisplayBlock = {
            start: x.start,
            end: y.end,
            text: x.text + y.text,
            folded,
            reasons: folded ? FOLD_REASONS.filter((r) => x.reasons.includes(r) || y.reasons.includes(r)) : [],
            related: folded ? [...new Set([...x.related, ...y.related])].sort((p, q) => p - q) : [],
            label: folded ? (y.end - y.start > x.end - x.start ? y.label : x.label) : null,
            collapsed: folded && (x.collapsed || y.collapsed),
        };
        const a = last.label!;
        const c = b.label!;
        const label: PdfLabel = {
            status: 'out',
            reasons: [...new Set([...a.reasons, ...c.reasons])],
            signaturesFrom: [...new Set([...a.signaturesFrom, ...c.signaturesFrom])].sort((p, q) => p - q),
            printedAs: a.printedAs ?? null,
        };
        out[out.length - 1] = { block, label };
    }
    return out;
}

/**
 * For every included email (list position -> start of a 'repeated-signature'
 * range -> list number of the email where it is kept), see the rules at the
 * top. `emails` and `plans`: the plan's input and output, same order.
 */
export function signatureSources(emails: readonly PlannedEmail[], plans: readonly MessagePlan[]): Map<number, Map<number, number>>
{
    const firstKept = new Map<string, number>(); // sender + "\n" + block key -> list number
    const out = new Map<number, Map<number, number>>();
    emails.forEach((e, k) =>
    {
        const plan = plans[k];
        if (plan === undefined)
        {
            return;
        }
        let sender: string;
        try
        {
            sender = senderKeyOf(e.message);
        }
        catch
        {
            sender = ''; // as the plan does
        }
        if (sender === '')
        {
            return; // an unknown sender's signature is never "repeated" (rule 3)
        }
        const body = e.message.bodyText;
        const found = new Map<number, number>();
        for (const r of plan.ranges)
        {
            if (r.reason !== 'repeated-signature')
            {
                continue;
            }
            const from = firstKept.get(`${sender}\n${signatureBlockKey(body.slice(r.start, r.end))}`);
            if (from !== undefined)
            {
                found.set(r.start, from);
            }
        }
        if (found.size > 0)
        {
            out.set(e.position, found);
        }
        // Recorded after the whole email, as the plan does.
        for (const r of plan.ranges)
        {
            if (r.reason !== 'signature' || !r.keep)
            {
                continue;
            }
            const key = `${sender}\n${signatureBlockKey(body.slice(r.start, r.end))}`;
            if (!firstKept.has(key))
            {
                firstKept.set(key, e.position + 1);
            }
        }
    });
    return out;
}

/**
 * A short text that changes whenever what the preview shows for this view
 * changes (the plan's ranges and flags, the signature sources): the preview
 * redraws an email's labels only when it differs. 'none' without a view.
 */
export function viewKey(view: PdfView | null): string
{
    if (view === null)
    {
        return 'none';
    }
    const p = view.plan;
    const ranges = p.ranges.map((r) => `${String(r.start)}-${String(r.end)}${r.keep ? '+' : '-'}${r.reason}`).join(',');
    const from = [...view.signatureFrom].map(([s, n]) => `${String(s)}>${String(n)}`).join(',');
    const cut = (view.pdfRanges ?? []).map((r) => `${String(r.start)}-${String(r.end)}${r.keep ? '+' : '-'}${printedKey(r)}`).join(',');
    return `${ranges}|${p.keptAllBecauseEmpty ? 'E' : ''}${p.fallback ? 'F' : ''}|${from}|${cut}`;
}
