// The page's side of the thread-analysis worker: starts a worker for one batch, sends
// it the parse results, enforces a time limit, and always terminates the
// worker. Same patterns as the parse workers (Source/email-reading/parse-worker-runner.ts).
//
// Every way the worker can go wrong becomes a batch-level failure with a
// plain detail, never a thrown error and never a page that waits forever:
// - it takes longer than THREAD_ANALYSIS_TIMEOUT_MS: terminated -> 'engine-timeout';
// - it fails: an 'error' event (for example its script could not load), a
//   'messageerror' event, a malformed message, a 'failed' message (the analysis
//   threw), or the worker could not be started or sent the request
//   -> 'engine-failed'.
// The page can also cancel the run (its `signal`, for "Clear everything"):
// the worker is terminated at once.
// Anything the worker sends after any of these is ignored.
//
// The worker is hidden behind a factory so this logic is unit tested with a
// fake worker.

import { connectWorker } from '../email-reading/parse-worker-runner';
import { isFromThreadAnalysisWorker } from './thread-analysis-worker-protocol';
import ThreadAnalysisWorker from './thread-analysis-worker?worker&inline';
import type { ThreadAnalysisFailure, ToThreadAnalysisWorker } from '../../Header/thread-analysis-worker-messages';
import type { WorkerEvents, WorkerHandle } from '../../Header/parse-worker-messages';
import type { ParseResult } from '../../Header/parsed-email';
import type { EngineResult } from '../../Header/thread-analysis-result';

/**
 * Time limit for organizing one batch: 60 seconds. A normal batch takes well
 * under a second; the known worst case of de-duplication on hostile input
 * took about 10 seconds in tests. 60 s leaves a wide margin for slow
 * computers and large batches, while still giving the user a clear message
 * instead of an endless wait if something goes wrong.
 */
export const THREAD_ANALYSIS_TIMEOUT_MS = 60_000;

/** Detail when the thread-analysis worker was stopped at the time limit. */
export const THREAD_ANALYSIS_TIMEOUT_DETAIL = 'organizing the messages took too long and was stopped';
/** Detail when the thread-analysis worker failed. */
export const THREAD_ANALYSIS_FAILED_DETAIL = 'the messages could not be organized (internal error)';

/** The analysis result, or why there is none. */
export type ThreadAnalysisOutcome =
    | { readonly ok: true; readonly result: EngineResult }
    | { readonly ok: false; readonly error: ThreadAnalysisFailure; readonly detail: string };

/** Starts a thread-analysis worker and connects its events. May throw (then the batch fails, nothing else). */
export type ThreadAnalysisWorkerFactory = (events: WorkerEvents) => WorkerHandle<ToThreadAnalysisWorker>;

export interface ThreadAnalysisRunOptions
{
    readonly createWorker: ThreadAnalysisWorkerFactory;
    readonly timeoutMs: number;
    /**
     * Stops the run ("Clear everything"): the worker is terminated at once and
     * the outcome is 'engine-failed' with THREAD_ANALYSIS_CANCELLED_DETAIL (the page
     * throws it away). Already aborted: no worker is started.
     */
    readonly signal?: AbortSignal;
}

/** Detail when the page cancelled the run. Never shown (see ThreadAnalysisRunOptions.signal). */
export const THREAD_ANALYSIS_CANCELLED_DETAIL = 'stopped because the page was cleared';

/** Runs the thread analysis on `results` in its own worker. Never throws and never rejects. */
export function runThreadAnalysisInWorker(results: readonly ParseResult[], options: ThreadAnalysisRunOptions): Promise<ThreadAnalysisOutcome>
{
    return new Promise((resolve) =>
    {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let worker: WorkerHandle<ToThreadAnalysisWorker> | undefined;
        const { signal } = options;

        const finish = (outcome: ThreadAnalysisOutcome): void =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            // Terminated in every case: a finished worker holds a copy of every
            // message, a stuck one holds the CPU.
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
        const fail = (error: ThreadAnalysisFailure): void =>
            finish({ ok: false, error, detail: error === 'engine-timeout' ? THREAD_ANALYSIS_TIMEOUT_DETAIL : THREAD_ANALYSIS_FAILED_DETAIL });
        // A function declaration (hoisted): finish() above removes it.
        function onAbort(): void
        {
            finish({ ok: false, error: 'engine-failed', detail: THREAD_ANALYSIS_CANCELLED_DETAIL });
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
            if (!isFromThreadAnalysisWorker(data) || data.type === 'failed')
            {
                fail('engine-failed');
                return;
            }
            finish({ ok: true, result: data.result });
        };

        try
        {
            worker = options.createWorker({ message: onMessage, failure: () => fail('engine-failed') });
            timer = setTimeout(() => fail('engine-timeout'), options.timeoutMs);
            // Copied, not moved: the parse results are plain objects (no buffers).
            worker.send({ type: 'run', results }, []);
        }
        catch
        {
            fail('engine-failed');
        }
    });
}

/**
 * The browser's thread-analysis worker: a new worker per batch, started from
 * thread-analysis-worker.ts. Inlined in the page's script and started from a `blob:`
 * URL, so it also starts with the network switched off; see
 * createBrowserWorker in Source/email-reading/parse-worker-runner.ts for why, and for how
 * the blob: URLs are cleaned up. A fresh worker per batch: one that timed out
 * or failed must be terminated anyway, and no state from an earlier batch can
 * leak into the next.
 */
export const createBrowserThreadAnalysisWorker: ThreadAnalysisWorkerFactory = (events) =>
    connectWorker<ToThreadAnalysisWorker>(new ThreadAnalysisWorker({ name: 'engine-worker' }), events);
