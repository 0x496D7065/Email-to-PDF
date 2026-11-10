// What the preview says about the no-repeat rule of the PDF (user decision
// 2026-11-06, task 8.10; preview labels task 8.11): with "Print full
// original text" off, a part of an email's text that the PDF prints as an
// email of its own (a rebuilt email in the PDF, or the real file a rebuilt
// one is linked to) is left out of that email in the PDF. The preview labels
// such a part "Not in this email in the PDF: printed as email #N"
// (src/ui/preview.ts, pdfLabelText) instead of the plan's own label. A
// forwarded part whose rebuilt email the reader unticked (task 8.13a, Q2)
// is left out too, labelled "Not in the PDF: forwarded email whose rebuilt
// email is unticked".
//
// It decides nothing on its own: it calls the PDF model's own functions
// (src/pdf/model.ts: noRepeat, which buildPdfDocument calls too, and
// pdfRanges, which cuts the plan with the same call the PDF makes) on the
// same input the PDF step gets (src/ui/page.ts, pdfInput: the included
// emails, their plans, the policy, the rebuilt emails chosen and those
// unticked). So the
// parts labelled are exactly the parts the PDF leaves out, and the email
// named is the one it prints them as.
//
// Pure function, no DOM (README.md, rule R7). Nothing is stored.

import type { EngineResult } from '../engine/engine';
import type { MessagePlan, OutputPolicy } from '../engine/output-plan';
import { noRepeat, pdfRanges, type PdfRange } from '../pdf/model';

/** The PDF step's input, as src/ui/page.ts (pdfInput) gives it. */
export interface PrintedElsewhereInput {
  readonly result: EngineResult;
  /** List positions of the included emails, in list order. */
  readonly positions: readonly number[];
  /** One plan per position, same order. */
  readonly plans: readonly MessagePlan[];
  readonly policy: OutputPolicy;
  /** Ids of the rebuilt emails chosen (src/ui/review.ts, includedRebuilt; ignored under "Print full original text"). */
  readonly rebuilt: readonly number[];
  /** True when "Rebuild conversation from replies" is off (src/pdf/model.ts, BuildPdfInput.rebuildingOff). Absent: false. */
  readonly rebuildingOff?: boolean;
  /** Ids of the rebuilt emails the reader unticked (src/ui/review.ts, untickedRebuilt; src/pdf/model.ts, BuildPdfInput.unticked). Absent: none. */
  readonly unticked?: readonly number[];
}

/**
 * Per list position, the ranges of its body as the PDF prints them
 * (src/pdf/model.ts, pdfRanges): only the emails the no-repeat rule leaves
 * something out of; an email not in the map is printed as its plan says.
 * Empty under "Print full original text" (every email is printed whole).
 */
export function printedElsewhereRanges(input: PrintedElsewhereInput): Map<number, readonly PdfRange[]> {
  const out = new Map<number, readonly PdfRange[]>();
  if (input.policy.unfoldEverything) return out;
  const { order, parts } = noRepeat(input);
  for (const slot of order.slots) {
    if (slot.kind !== 'email') continue;
    const list = parts.get(slot.position);
    const message = input.result.messages[slot.position]?.message;
    if (list === undefined || message === undefined) continue;
    const ranges = pdfRanges(message.bodyText, input.plans[slot.plan], input.policy, list);
    if (ranges !== null) out.set(slot.position, ranges);
  }
  return out;
}
