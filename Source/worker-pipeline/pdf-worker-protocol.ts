// The messages between the page and the PDF worker, and the worker's side of
// the conversation.
//
// One worker makes one PDF:
//   page   -> worker: { type: 'make', input, fonts }
//   worker -> page:   { type: 'done', bytes, fileName, pageCount }  (or { type: 'failed' })
// Then the page terminates the worker. See pdf-worker-runner.ts for the page's side
// and pdf-worker.ts for why the PDF is made in a worker.
//
// `input` is everything generatePdf needs except the fonts, as plain data
// (the browser copies it, structured clone). The fonts travel as their WOFF
// BYTES, copied from the page's own (the page keeps its copy for the next
// PDF), and the worker parses them: the worker must never import the font
// chunk itself (see Source/pdf-export/parse-fonts.ts). The finished PDF's bytes are
// MOVED back to the page (a transfer), not copied.
// Nothing is stored anywhere (README.md, rule R5).

import { generatePdf } from '../pdf-export/generate';
import { PDF_FONT_NAMES, parsePdfFonts } from '../pdf-export/parse-fonts';
import { isSupportedLocale } from '../web-page/translations';
import type { GeneratedPdf } from '../../Header/pdf-document-model';
import type { FromPdfWorker, MakePdfRequest, ToPdfWorker } from '../../Header/pdf-worker-messages';

function isRecord(value: unknown): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null;
}

/** True if `data` is a well-formed page -> PDF worker message (its overall shape). */
export function isToPdfWorker(data: unknown): data is ToPdfWorker
{
    if (!isRecord(data) || data.type !== 'make' || !isRecord(data.input) || !isRecord(data.fonts))
    {
        return false;
    }
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
    if (!isRecord(data))
    {
        return false;
    }
    if (data.type === 'failed')
    {
        return true;
    }
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
    if (buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength)
    {
        return new Uint8Array(buffer);
    }
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
        if (!isToPdfWorker(data))
        {
            return;
        }
        // One PDF per worker: a second request is ignored.
        if (started)
        {
            return;
        }
        started = true;
        let pdf: GeneratedPdf;
        try
        {
            pdf = await make(data);
        }
        catch
        {
            post({ type: 'failed' }, []);
            return;
        }
        try
        {
            const bytes = ownBuffer(pdf.bytes);
            post({ type: 'done', bytes, fileName: pdf.fileName, pageCount: pdf.pageCount }, [bytes.buffer]);
        }
        catch
        {
            // The result could not be sent (should never happen: plain data and
            // one buffer). Say so instead of leaving the page waiting.
            post({ type: 'failed' }, []);
        }
    };
}
