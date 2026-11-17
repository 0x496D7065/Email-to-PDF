// The page's side of the PDF worker: starts a worker for one PDF, sends it
// the input and the font bytes, enforces a time limit, and always
// terminates the worker. Same patterns as the engine worker
// (engine-runner.ts).
//
// Every way the worker can go wrong becomes an error code, never a thrown
// error and never a page that waits forever:
// - it takes longer than the time limit (pdfTimeoutMs): terminated -> 'timeout';
// - it could not be started (the factory throws) -> 'not-started';
// - it fails: an 'error' event, a 'messageerror' event, a malformed
//   message, a 'failed' message (making the PDF threw), or the request
//   could not be sent -> 'tool-error';
// - the page cancels it (its `signal`: "Clear everything" or a changed
//   choice): terminated at once -> 'cancelled' (the page throws it away).
// Anything the worker sends after any of these is ignored.
//
// The worker is hidden behind a factory so this logic is unit tested with a
// fake worker.

import { connectWorker, type WorkerEvents, type WorkerHandle } from '../parsing/worker-runner';
import { isFromPdfWorker, type MakePdfRequest, type ToPdfWorker } from './pdf-protocol';
import PdfWorker from './pdf-worker?worker&inline';

/**
 * Time limit for one PDF: 2 minutes plus 50 ms per email. A PDF of 2000
 * short emails takes about a second on a fast computer; the limit leaves a
 * wide margin for slow computers and long emails (2000 emails: 220 s),
 * while still giving the user a clear message instead of an endless wait if
 * something goes wrong.
 */
export const PDF_TIMEOUT_BASE_MS = 120_000;
export const PDF_TIMEOUT_PER_EMAIL_MS = 50;

/** The time limit for a PDF of `emails` emails (see PDF_TIMEOUT_BASE_MS). */
export function pdfTimeoutMs(emails: number): number
{
    return PDF_TIMEOUT_BASE_MS + PDF_TIMEOUT_PER_EMAIL_MS * Math.max(0, emails);
}

/** Why there is no PDF. */
export type PdfFailure = 'timeout' | 'tool-error' | 'not-started' | 'cancelled';

/** The PDF, or why there is none. */
export type PdfOutcome =
    | { readonly ok: true; readonly bytes: Uint8Array; readonly fileName: string; readonly pageCount: number }
    | { readonly ok: false; readonly error: PdfFailure };

/** Starts a PDF worker and connects its events. May throw (then the outcome is 'not-started'). */
export type PdfWorkerFactory = (events: WorkerEvents) => WorkerHandle<ToPdfWorker>;

export interface PdfRunOptions {
    readonly createWorker: PdfWorkerFactory;
    readonly timeoutMs: number;
    /** Stops the run: the worker is terminated at once ('cancelled'). Already aborted: no worker is started. */
    readonly signal?: AbortSignal;
}

/** Makes one PDF in its own worker. Never throws and never rejects. */
export function runPdfInWorker(request: MakePdfRequest, options: PdfRunOptions): Promise<PdfOutcome>
{
    return new Promise((resolve) =>
    {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let worker: WorkerHandle<ToPdfWorker> | undefined;
        const { signal } = options;

        const finish = (outcome: PdfOutcome): void =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            // Terminated in every case: a finished worker holds a copy of every
            // email, a stuck one holds the CPU.
            try
            {
                worker?.terminate();
            }
            catch
            {
                // Nothing more to do: the outcome is what matters.
            }
            resolve(outcome);
        };
        const fail = (error: PdfFailure): void => finish({ ok: false, error });
        // A function declaration (hoisted): finish() above removes it.
        function onAbort(): void
        {
            fail('cancelled');
        }
        if (signal?.aborted === true)
        {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });

        const onMessage = (data: unknown): void =>
        {
            if (settled)
            {
                return;
            }
            if (!isFromPdfWorker(data) || data.type === 'failed')
            {
                fail('tool-error');
                return;
            }
            finish({ ok: true, bytes: data.bytes, fileName: data.fileName, pageCount: data.pageCount });
        };

        try
        {
            worker = options.createWorker({ message: onMessage, failure: () => fail('tool-error') });
        }
        catch
        {
            fail('not-started');
            return;
        }
        try
        {
            timer = setTimeout(() => fail('timeout'), options.timeoutMs);
            // Copied, not moved: the page keeps its input and its font bytes.
            worker.send(request, []);
        }
        catch
        {
            fail('tool-error');
        }
    });
}

/**
 * The browser's PDF worker: a new worker per PDF, started from
 * pdf-worker.ts. Inlined in the page's script and started from a `blob:`
 * URL, so it also starts with the network switched off; see
 * createBrowserWorker in src/parsing/worker-runner.ts for why, and for how
 * the blob: URLs of the workers are cleaned up.
 */
export const createBrowserPdfWorker: PdfWorkerFactory = (events) =>
    connectWorker<ToPdfWorker>(new PdfWorker({ name: 'pdf-worker' }), events);
