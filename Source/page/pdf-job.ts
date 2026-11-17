// Step 3's state, without any DOM (Source/page/download-step.ts shows it): one
// PDF job at a time, and the finished PDF as a blob: URL until it is no
// longer valid.
//
//   idle --start--> making --PDF made--> ready
//                          --failed----> error
//   any --start--> making (a new job: the old one is stopped, its URL revoked)
//   making/ready --inputsChanged--> idle (changed: true)
//   any --reset--> idle (changed: false)
//
// - Each job has an id. Whatever a job reports after it was stopped or
//   replaced (inputsChanged, reset, a newer start) is ignored, so a stale
//   PDF can never be offered: an outcome is only used when its id is still
//   the current one.
// - Stopping a job aborts its signal: the runner terminates the worker at
//   once (Source/worker-pipeline/pdf-runner.ts).
// - The PDF lives in memory only (README.md, rule R5): as a Blob behind one
//   blob: URL, made when the job ends (createUrl). The URL is revoked on
//   every way out of 'ready': a new job, a changed input, reset ("Clear
//   everything") and dispose (the page is being left). It is NOT revoked
//   right after the download starts: some browsers then fail the download,
//   and the "Download again" link needs it.
// - Nothing here touches the email text: the bytes go from the worker into
//   the Blob, and nothing else keeps them.

import type { MakePdfRequest, PdfFailure, PdfOutcome } from '../../Header/pdf-worker-messages';

/** A failure the page explains ('cancelled' never reaches the page: a stopped job is dropped). */
export type PdfError = Exclude<PdfFailure, 'cancelled'>;

/**
 * Why a PDF cannot be made now (Source/page/page.ts works it out):
 * 'no-emails' (nothing shown in step 2), 'busy' (files being read, the list
 * being built or the PDF plans being worked out), 'none-included' (every
 * email unticked), 'none-with-text' (every ticked email has no text, so the
 * PDF would leave them all out, task 8.14, Source/page-logic/no-text.ts),
 * 'labels-failed' (the plans could not be worked out).
 */
export type PdfUnavailable = 'no-emails' | 'busy' | 'none-included' | 'none-with-text' | 'labels-failed';

export type PdfJobState =
    /** No PDF. `changed`: a PDF was being made or was ready, and a choice changed since (it was dropped). */
    | { readonly kind: 'idle'; readonly changed: boolean }
    | { readonly kind: 'making' }
    | { readonly kind: 'ready'; readonly url: string; readonly fileName: string; readonly pageCount: number }
    | { readonly kind: 'error'; readonly error: PdfError };

export interface PdfJobOptions
{
    /** Makes the PDF (the browser: runPdfInWorker). Should never reject; a rejection counts as 'tool-error'. */
    readonly run: (request: MakePdfRequest, signal: AbortSignal) => Promise<PdfOutcome>;
    /** Puts the bytes in a Blob and returns its blob: URL (the browser: URL.createObjectURL). */
    readonly createUrl: (bytes: Uint8Array, fileName: string) => string;
    /** Frees a URL made by createUrl (the browser: URL.revokeObjectURL). */
    readonly revokeUrl: (url: string) => void;
    /** Called after each change of state. */
    readonly onChange: (state: PdfJobState) => void;
}

export interface PdfJob
{
    state(): PdfJobState;
    /** Starts a new job (stopping any job running and dropping any PDF ready). */
    start(request: MakePdfRequest): void;
    /** A choice changed: stops a running job, drops a ready PDF (and an error). */
    inputsChanged(): void;
    /** "Clear everything": stops and drops everything, back to the start. */
    reset(): void;
    /** True while a job is running. */
    isMaking(): boolean;
}

export function createPdfJob(options: PdfJobOptions): PdfJob
{
    let state: PdfJobState = { kind: 'idle', changed: false };
    // The current job: its id and its stop switch.
    let jobId = 0;
    let controller: AbortController | null = null;

    function set(next: PdfJobState): void
    {
        state = next;
        try
        {
            options.onChange(state);
        }
        catch
        {
            // A broken listener must not break the job's bookkeeping.
        }
    }

    /** Stops the running job and frees the ready PDF. Any later report of that job is ignored. */
    function stop(): void
    {
        jobId++;
        controller?.abort();
        controller = null;
        if (state.kind === 'ready')
        {
            try
            {
                options.revokeUrl(state.url);
            }
            catch
            {
                // Revoking cannot really fail; if it did, the page is still right.
            }
        }
    }

    function finish(id: number, outcome: PdfOutcome): void
    {
        if (id !== jobId)
        {
            return; // stopped or replaced meanwhile: dropped
        }
        controller = null;
        if (!outcome.ok)
        {
            // 'cancelled' only comes from our own stop(), which changed jobId; defensive.
            set(outcome.error === 'cancelled' ? { kind: 'idle', changed: false } : { kind: 'error', error: outcome.error });
            return;
        }
        let url: string;
        try
        {
            url = options.createUrl(outcome.bytes, outcome.fileName);
        }
        catch
        {
            set({ kind: 'error', error: 'tool-error' });
            return;
        }
        set({ kind: 'ready', url, fileName: outcome.fileName, pageCount: outcome.pageCount });
    }

    return {
        state: () => state,
        isMaking: () => state.kind === 'making',
        start(request)
        {
            stop();
            const id = jobId;
            const mine = new AbortController();
            controller = mine;
            set({ kind: 'making' });
            let running: Promise<PdfOutcome>;
            try
            {
                running = options.run(request, mine.signal);
            }
            catch
            {
                running = Promise.resolve({ ok: false, error: 'tool-error' });
            }
            running.then(
                (outcome) => finish(id, outcome),
                () => finish(id, { ok: false, error: 'tool-error' }),
            );
        },
        inputsChanged()
        {
            const had = state.kind === 'making' || state.kind === 'ready';
            stop();
            if (state.kind !== 'idle' || had)
            {
                set({ kind: 'idle', changed: had });
            }
        },
        reset()
        {
            stop();
            set({ kind: 'idle', changed: false });
        },
    };
}
