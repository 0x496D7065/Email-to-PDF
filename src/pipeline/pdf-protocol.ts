// The messages between the page and the PDF worker, and the worker's side of
// the conversation.
//
// One worker makes one PDF:
//   page   -> worker: { type: 'make', input, fonts }
//   worker -> page:   { type: 'done', bytes, fileName, pageCount }  (or { type: 'failed' })
// Then the page terminates the worker. See pdf-runner.ts for the page's side
// and pdf-worker.ts for why the PDF is made in a worker.
//
// `input` is everything generatePdf needs except the fonts, as plain data
// (the browser copies it, structured clone). The fonts travel as their WOFF
// BYTES, copied from the page's own (the page keeps its copy for the next
// PDF), and the worker parses them: the worker must never import the font
// chunk itself (see src/pdf/parse-fonts.ts). The finished PDF's bytes are
// MOVED back to the page (a transfer), not copied.
// Nothing is stored anywhere (README.md, rule R5).

import type { EngineResult } from '../engine/engine';
import type { MessagePlan, OutputPolicy } from '../engine/output-plan';
import type { PdfFontName } from '../pdf/fonts';
import { generatePdf, type GeneratedPdf } from '../pdf/generate';
import { PDF_FONT_NAMES, parsePdfFonts } from '../pdf/parse-fonts';
import { isSupportedLocale } from '../ui/i18n';

/** What one PDF is made of: the input of generatePdf without the fonts. */
export interface PdfJobInput {
    readonly result: EngineResult;
    /** List positions of the included emails, in list order. */
    readonly positions: readonly number[];
    /** One plan per position, same order (src/ui/pdf-labels.ts: the preview's own plans). */
    readonly plans: readonly MessagePlan[];
    /**
     * Ids of the rebuilt emails the reader wants in the PDF (src/ui/review.ts,
     * includedRebuilt; [] when the switch is off). Absent: none. The PDF still
     * applies the follow-source rule (src/pdf/model.ts, planPdfOrder).
     */
    readonly rebuilt?: readonly number[];
    /**
     * True when "Rebuild conversation from replies" is off: no rebuilt email
     * counts as unticked (src/pdf/model.ts, BuildPdfInput.rebuildingOff, task
     * 8.13a). Absent: false.
     */
    readonly rebuildingOff?: boolean;
    /**
     * Ids of the rebuilt emails whose card the reader unticked (src/ui/review.ts,
     * untickedRebuilt): only their forwarded parts are left out of a forward
     * (src/pdf/model.ts, BuildPdfInput.unticked, task 8.13a review round 2).
     * Absent: none.
     */
    readonly unticked?: readonly number[];
    readonly policy: OutputPolicy;
    readonly timeZone: string;
    /** When the PDF is made (ms since 1970 UTC), taken on the page. */
    readonly generatedAt: number;
    /**
     * The PDF's language: the page language when the button was pressed (a
     * language the page ships, e.g. 'en'). The worker uses this, never a
     * default of its own.
     */
    readonly locale: string;
}

/** The WOFF bytes of the four PDF fonts. */
export type PdfFontBytes = Readonly<Record<PdfFontName, Uint8Array>>;

export interface MakePdfRequest {
    readonly type: 'make';
    readonly input: PdfJobInput;
    readonly fonts: PdfFontBytes;
}

/** Page -> PDF worker. */
export type ToPdfWorker = MakePdfRequest;

export interface PdfDoneMessage {
    readonly type: 'done';
    readonly bytes: Uint8Array;
    readonly fileName: string;
    readonly pageCount: number;
}

/** Making the PDF threw (a bug or a limit reached, not the user's fault); no details are sent. */
export interface PdfFailedMessage {
    readonly type: 'failed';
}

/** PDF worker -> page. */
export type FromPdfWorker = PdfDoneMessage | PdfFailedMessage;

function isRecord(value: unknown): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null;
}

/** True if `data` is a well-formed page -> PDF worker message (its overall shape). */
export function isToPdfWorker(data: unknown): data is ToPdfWorker
{
    if (!isRecord(data) || data.type !== 'make' || !isRecord(data.input) || !isRecord(data.fonts)) return false;
    const { input, fonts } = data;
    return (
        isRecord(input.result) &&
        Array.isArray(input.positions) &&
        Array.isArray(input.plans) &&
        input.positions.length === input.plans.length &&
        (input.rebuilt === undefined || (Array.isArray(input.rebuilt) && input.rebuilt.every((id) => Number.isInteger(id)))) &&
        (input.rebuildingOff === undefined || typeof input.rebuildingOff === 'boolean') &&
        (input.unticked === undefined || (Array.isArray(input.unticked) && input.unticked.every((id) => Number.isInteger(id) && (id as number) >= 0))) &&
        isRecord(input.policy) &&
        typeof input.timeZone === 'string' &&
        typeof input.generatedAt === 'number' &&
        isSupportedLocale(input.locale) &&
        PDF_FONT_NAMES.every((name) => fonts[name] instanceof Uint8Array)
    );
}

/**
 * True if `data` is a well-formed PDF worker -> page message. The worker
 * runs our own code, so this guards against bugs and stray messages, not
 * against a hostile worker.
 */
export function isFromPdfWorker(data: unknown): data is FromPdfWorker
{
    if (!isRecord(data)) return false;
    if (data.type === 'failed') return true;
    return (
        data.type === 'done' &&
        data.bytes instanceof Uint8Array &&
        typeof data.fileName === 'string' &&
        typeof data.pageCount === 'number' &&
        Number.isInteger(data.pageCount) &&
        data.pageCount >= 0
    );
}

/** Makes the PDF of one request: parses the fonts, then runs generatePdf. */
export async function makePdf(request: MakePdfRequest): Promise<GeneratedPdf>
{
    const fonts = await parsePdfFonts(request.fonts);
    return generatePdf({ ...request.input, fonts });
}

/**
 * The bytes in a buffer of their own, so they can be moved to the page: a
 * view over a whole plain ArrayBuffer is used as it is, anything else is
 * copied first.
 */
export function ownBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer>
{
    const { buffer } = bytes;
    if (buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) return new Uint8Array(buffer);
    return bytes.slice();
}

/**
 * The worker's side: returns the function to call with each message the
 * worker receives. `post` sends a message to the page (with the buffers to
 * move); `make` makes the PDF (tests pass a fake or a broken one). Kept
 * apart from pdf-worker.ts so it runs in unit tests without a browser.
 * The returned promise is for the tests; the worker does not wait for it.
 */
export function createPdfWorkerSide(
    post: (message: FromPdfWorker, transfer: Transferable[]) => void,
    make: (request: MakePdfRequest) => Promise<GeneratedPdf> = makePdf,
): (data: unknown) => Promise<void>
{
    let started = false;
    return async (data) =>
    {
        if (!isToPdfWorker(data)) return;
        // One PDF per worker: a second request is ignored.
        if (started) return;
        started = true;
        let made: GeneratedPdf;
        try
        {
            made = await make(data);
        }
        catch
        {
            post({ type: 'failed' }, []);
            return;
        }
        try
        {
            const bytes = ownBuffer(made.bytes);
            post({ type: 'done', bytes, fileName: made.fileName, pageCount: made.pageCount }, [bytes.buffer]);
        }
        catch
        {
            // The result could not be sent (should never happen: plain data and
            // one buffer). Say so instead of leaving the page waiting.
            post({ type: 'failed' }, []);
        }
    };
}
