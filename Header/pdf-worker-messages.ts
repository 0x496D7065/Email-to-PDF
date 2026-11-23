// Header: the messages between the page and the PDF worker, and the outcome
// the page gets. Shared types only, no code (README.md, "Where things are").
// The checks that every message really has this shape are isToPdfWorker /
// isFromPdfWorker in Source/worker-pipeline/pdf-worker-protocol.ts.
// Used by worker-pipeline/ (pdf-worker-protocol, pdf-worker, pdf-worker-runner) and web-page/
// (pdf-job, download-step, page).

import type { MessagePlan, OutputPolicy } from './output-plan';
import type { PdfFontName } from './pdf-fonts';
import type { ThreadAnalysisResult } from './thread-analysis-result';

/** What one PDF is made of: the input of generatePdf without the fonts. */
export interface PdfJobInput
{
    readonly result: ThreadAnalysisResult;
    /** List positions of the included emails, in list order. */
    readonly positions: readonly number[];
    /** One plan per position, same order (Source/web-page/pdf-labels.ts: the preview's own plans). */
    readonly plans: readonly MessagePlan[];
    /**
     * Ids of the rebuilt emails the reader wants in the PDF (Source/web-page/review.ts,
     * includedRebuilt; [] when the switch is off). Absent: none. The PDF still
     * applies the follow-source rule (Source/pdf-export/build-pdf-document.ts, planPdfOrder).
     */
    readonly rebuilt?: readonly number[];
    /**
     * True when "Rebuild conversation from replies" is off: no rebuilt email
     * counts as unticked (Source/pdf-export/build-pdf-document.ts, BuildPdfInput.rebuildingOff, task
     * 8.13a). Absent: false.
     */
    readonly rebuildingOff?: boolean;
    /**
     * Ids of the rebuilt emails whose card the reader unticked (Source/web-page/review.ts,
     * untickedRebuilt): only their forwarded parts are left out of a forward
     * (Source/pdf-export/build-pdf-document.ts, BuildPdfInput.unticked, task 8.13a review round 2).
     * Absent: none.
     */
    readonly unticked?: readonly number[];
    readonly policy: OutputPolicy;
    /** When the PDF is made (ms since 1970 UTC), taken on the page. */
    readonly generatedAt: number;
    /**
     * The offset of the page's clock from UTC at `generatedAt`, in minutes,
     * taken on the page: the PDF prints its generation date on the reader's
     * own clock (Source/pdf-export/build-pdf-document.ts, BuildPdfInput.generatedOffsetMinutes).
     */
    readonly generatedOffsetMinutes: number;
    /**
     * The PDF's language: the page language when the button was pressed (a
     * language the page ships, e.g. 'en'). The worker uses this, never a
     * default of its own.
     */
    readonly locale: string;
}

/** The WOFF bytes of the four PDF fonts. */
export type PdfFontBytes = Readonly<Record<PdfFontName, Uint8Array>>;

export interface MakePdfRequest
{
    readonly type: 'make';
    readonly input: PdfJobInput;
    readonly fonts: PdfFontBytes;
}

/** Page -> PDF worker. */
export type ToPdfWorker = MakePdfRequest;

export interface PdfDoneMessage
{
    readonly type: 'done';
    readonly bytes: Uint8Array;
    readonly fileName: string;
    readonly pageCount: number;
}

/** Making the PDF threw (a bug or a limit reached, not the user's fault); no details are sent. */
export interface PdfFailedMessage
{
    readonly type: 'failed';
}

/** PDF worker -> page. */
export type FromPdfWorker = PdfDoneMessage | PdfFailedMessage;

/** Why there is no PDF. */
export type PdfFailure = 'timeout' | 'tool-error' | 'not-started' | 'cancelled';

/** The PDF, or why there is none. */
export type PdfOutcome =
    | { readonly ok: true; readonly bytes: Uint8Array; readonly fileName: string; readonly pageCount: number }
    | { readonly ok: false; readonly error: PdfFailure };
