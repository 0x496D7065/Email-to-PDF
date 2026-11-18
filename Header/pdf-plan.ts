// Header: what the preview shows of each email's PDF (in, out or partly; its
// blocks and their labels). Shared types only, no code (README.md, "Where
// things are"). web-page-logic/ (pdf-plan, display-blocks) computes it; web-page/
// (preview, pdf-labels) shows it.

import type { MessagePlan, PlanReason } from './output-plan';
import type { NormalizedMessage } from './parsed-email';
import type { PdfRange, PrintedAs } from './pdf-document-model';
import type { FoldReason } from './thread-analysis-result';

/** 'partly': a block with kept and left-out text (never produced by pdfBlocks; a safe default). */
export type PdfStatus = 'in' | 'out' | 'partly';

/** One email's plan, as the preview needs it. */
export interface PdfView
{
    readonly plan: MessagePlan;
    /** Start of a 'repeated-signature' range -> the list number (1-based) of the email where that signature is kept. */
    readonly signatureFrom: ReadonlyMap<number, number>;
    /**
     * The body's ranges as the PDF prints them, when the no-repeat rule
     * leaves something out of it (Source/web-page-logic/printed-elsewhere.ts); they
     * replace `plan.ranges` for the labels. Absent: the plan's ranges.
     */
    readonly pdfRanges?: readonly PdfRange[];
}

/** What the preview says about one block. */
export interface PdfLabel
{
    readonly status: PdfStatus;
    /** The plan's reasons for the block's text, in order, unique. */
    readonly reasons: readonly PlanReason[];
    /**
     * For repeated signatures: the list numbers (1-based) of the emails where
     * they are first kept, distinct, in increasing order (a block can hold
     * more than one repeated signature). Empty if none is known.
     */
    readonly signaturesFrom: readonly number[];
    /**
     * Status 'out' only: the block is left out because the PDF prints it as
     * this email (the no-repeat rule, see the top). Absent or null otherwise.
     */
    readonly printedAs?: PrintedAs | null;
}

/** A display block and its label (null: a shown block, fully in the PDF, or no plan). */
export interface PdfBlock
{
    readonly block: DisplayBlock;
    readonly label: PdfLabel | null;
}

/** One included email, for signatureSources. */
export interface PlannedEmail
{
    readonly message: NormalizedMessage;
    /** Its position (0-based) in the preview list. */
    readonly position: number;
}

/** One block for the preview / PDF. The text is always present, even when folded. */
export interface DisplayBlock
{
    /** Offsets in the body: [start, end). Also a stable key (e.g. for expand toggles). */
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly folded: boolean;
    /** Union of the reasons of the folded segments in this block, in FOLD_REASONS order; [] when shown. */
    readonly reasons: readonly FoldReason[];
    /** Union of their linked message indices, ascending; [] when shown. */
    readonly related: readonly number[];
    /**
     * What to call the block ("signature", "quoted text", ...): the reason
     * covering the most characters (see the rules at the top of Source/web-page-logic/pdf-plan.ts);
     * null when shown.
     */
    readonly label: FoldReason | null;
    /** True when the preview should show this block collapsed (folded and not "unfold all"). */
    readonly collapsed: boolean;
}
