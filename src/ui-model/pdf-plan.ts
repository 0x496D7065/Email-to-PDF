// What the preview says about the PDF: for each folded block of an email,
// whether it will be in the PDF or not, and why. The decision itself is the
// PDF's own plan (planOutput, src/engine/output-plan.ts), run on the same
// emails the PDF gets (the included ones, in list order, with the same
// policy): this file only maps a MessagePlan onto the preview's display
// blocks (src/ui-model/display-blocks.ts). It decides nothing on its own.
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
//
// Collapse, never delete (README.md, rule R6): blocks only group and cut
// the body; their texts joined always give the body back unchanged.
//
// Pure functions, no DOM (README.md, rule R7).

import type { MessagePlan, PlanRange, PlanReason } from '../engine/output-plan';
import type { Segment } from '../engine/segments';
import { senderKeyOf, signatureBlockKey } from '../engine/signature';
import type { NormalizedMessage } from '../parsing/types';
import { displayBlocks, type DisplayBlock } from './display-blocks';

/** 'partly': a block with kept and left-out text (never produced by pdfBlocks; a safe default). */
export type PdfStatus = 'in' | 'out' | 'partly';

/** What the preview says about one block. */
export interface PdfLabel {
  readonly status: PdfStatus;
  /** The plan's reasons for the block's text, in order, unique. */
  readonly reasons: readonly PlanReason[];
  /**
   * For repeated signatures: the list numbers (1-based) of the emails where
   * they are first kept, distinct, in increasing order (a block can hold
   * more than one repeated signature). Empty if none is known.
   */
  readonly signaturesFrom: readonly number[];
}

/** One email's plan, as the preview needs it. */
export interface PdfView {
  readonly plan: MessagePlan;
  /** Start of a 'repeated-signature' range -> the list number (1-based) of the email where that signature is kept. */
  readonly signatureFrom: ReadonlyMap<number, number>;
}

/** A display block and its label (null: a shown block, fully in the PDF, or no plan). */
export interface PdfBlock {
  readonly block: DisplayBlock;
  readonly label: PdfLabel | null;
}

/** True if text[start, end) has a character that is not white space. */
export function hasNonSpace(text: string, start: number, end: number): boolean {
  return /\S/.test(text.slice(start, end));
}

/**
 * Where the preview must start a new block: the start of each range with
 * text whose `keep` differs from the previous range with text. Whitespace
 * ranges in between stay with the block above.
 */
export function pdfBreaks(text: string, ranges: readonly PlanRange[]): number[] {
  const breaks: number[] = [];
  let lastKeep: boolean | null = null;
  for (const r of ranges) {
    if (!hasNonSpace(text, r.start, r.end)) continue;
    if (lastKeep !== null && r.keep !== lastKeep) breaks.push(r.start);
    lastKeep = r.keep;
  }
  return breaks;
}

/** The label of text[start, end) under `view` (see the rules at the top). */
export function labelOf(text: string, start: number, end: number, view: PdfView): PdfLabel {
  const overlapping = view.plan.ranges.filter((r) => r.start < end && r.end > start);
  const withText = overlapping.filter((r) => hasNonSpace(text, Math.max(r.start, start), Math.min(r.end, end)));
  const deciding = withText.length > 0 ? withText : overlapping;
  const kept = deciding.filter((r) => r.keep).length;
  const status: PdfStatus = kept === deciding.length ? 'in' : kept === 0 ? 'out' : 'partly';
  const reasons = [...new Set(deciding.map((r) => r.reason))];
  const from = new Set<number>();
  for (const r of deciding) {
    if (r.reason !== 'repeated-signature') continue;
    const n = view.signatureFrom.get(r.start);
    if (n !== undefined) from.add(n);
  }
  return { status, reasons, signaturesFrom: [...from].sort((a, b) => a - b) };
}

/**
 * The preview's blocks of one email, with their PDF labels. Without a view
 * (the email is not in the PDF, or the plan is not ready), the plain display
 * blocks with no labels.
 */
export function pdfBlocks(text: string, segments: readonly Segment[], view: PdfView | null): PdfBlock[] {
  if (view === null) return displayBlocks(text, segments, { unfoldAll: false }).map((block) => ({ block, label: null }));
  const blocks = displayBlocks(text, segments, { unfoldAll: false, breaks: pdfBreaks(text, view.plan.ranges) });
  return blocks.map((block) => {
    const label = labelOf(text, block.start, block.end, view);
    // A shown block is labelled only if the plan leaves something of it out (a bug, see the top).
    return { block, label: block.folded || label.status !== 'in' ? label : null };
  });
}

/** One included email, for signatureSources. */
export interface PlannedEmail {
  readonly message: NormalizedMessage;
  /** Its position (0-based) in the preview list. */
  readonly position: number;
}

/**
 * For every included email (list position -> start of a 'repeated-signature'
 * range -> list number of the email where it is kept), see the rules at the
 * top. `emails` and `plans`: the plan's input and output, same order.
 */
export function signatureSources(emails: readonly PlannedEmail[], plans: readonly MessagePlan[]): Map<number, Map<number, number>> {
  const firstKept = new Map<string, number>(); // sender + "\n" + block key -> list number
  const out = new Map<number, Map<number, number>>();
  emails.forEach((e, k) => {
    const plan = plans[k];
    if (plan === undefined) return;
    let sender: string;
    try {
      sender = senderKeyOf(e.message);
    } catch {
      sender = ''; // as the plan does
    }
    if (sender === '') return; // an unknown sender's signature is never "repeated" (rule 3)
    const body = e.message.bodyText;
    const found = new Map<number, number>();
    for (const r of plan.ranges) {
      if (r.reason !== 'repeated-signature') continue;
      const from = firstKept.get(`${sender}\n${signatureBlockKey(body.slice(r.start, r.end))}`);
      if (from !== undefined) found.set(r.start, from);
    }
    if (found.size > 0) out.set(e.position, found);
    // Recorded after the whole email, as the plan does.
    for (const r of plan.ranges) {
      if (r.reason !== 'signature' || !r.keep) continue;
      const key = `${sender}\n${signatureBlockKey(body.slice(r.start, r.end))}`;
      if (!firstKept.has(key)) firstKept.set(key, e.position + 1);
    }
  });
  return out;
}

/**
 * A short text that changes whenever what the preview shows for this view
 * changes (the plan's ranges and flags, the signature sources): the preview
 * redraws an email's labels only when it differs. 'none' without a view.
 */
export function viewKey(view: PdfView | null): string {
  if (view === null) return 'none';
  const p = view.plan;
  const ranges = p.ranges.map((r) => `${String(r.start)}-${String(r.end)}${r.keep ? '+' : '-'}${r.reason}`).join(',');
  const from = [...view.signatureFrom].map(([s, n]) => `${String(s)}>${String(n)}`).join(',');
  return `${ranges}|${p.keptAllBecauseEmpty ? 'E' : ''}${p.fallback ? 'F' : ''}|${from}`;
}
