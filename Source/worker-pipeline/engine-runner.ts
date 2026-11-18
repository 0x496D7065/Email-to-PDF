// The page's side of the engine worker: starts a worker for one batch, sends
// it the parse results, enforces a time limit, and always terminates the
// worker. Same patterns as the parse workers (Source/email-reading/parse-worker-runner.ts).
//
// Every way the worker can go wrong becomes a batch-level failure with a
// plain detail, never a thrown error and never a page that waits forever:
// - it takes longer than ENGINE_TIMEOUT_MS: terminated -> 'engine-timeout';
// - it fails: an 'error' event (for example its script could not load), a
//   'messageerror' event, a malformed message, a 'failed' message (the engine
//   threw), or the worker could not be started or sent the request
//   -> 'engine-failed'.
// The page can also cancel the run (its `signal`, for "Clear everything"):
// the worker is terminated at once.
// Anything the worker sends after any of these is ignored.
//
// The worker is hidden behind a factory so this logic is unit tested with a
// fake worker.

import { connectWorker } from '../email-reading/parse-worker-runner';
import { isFromEngineWorker } from './engine-protocol';
import EngineWorker from './engine-worker?worker&inline';
import type { EngineFailure, ToEngineWorker } from '../../Header/engine-worker-messages';
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
export const ENGINE_TIMEOUT_MS = 60_000;

/** Detail when the engine worker was stopped at the time limit. */
export const ENGINE_TIMEOUT_DETAIL = 'organizing the messages took too long and was stopped';
/** Detail when the engine worker failed. */
export const ENGINE_FAILED_DETAIL = 'the messages could not be organized (internal error)';

/** The engine's result, or why there is none. */
export type EngineOutcome =
    | { readonly ok: true; readonly result: EngineResult }
    | { readonly ok: false; readonly error: EngineFailure; readonly detail: string };

/** Starts an engine worker and connects its events. May throw (then the batch fails, nothing else). */
export type EngineWorkerFactory = (events: WorkerEvents) => WorkerHandle<ToEngineWorker>;

export interface EngineRunOptions
{
    readonly createWorker: EngineWorkerFactory;
    readonly timeoutMs: number;
    /**
     * Stops the run ("Clear everything"): the worker is terminated at once and
     * the outcome is 'engine-failed' with ENGINE_CANCELLED_DETAIL (the page
     * throws it away). Already aborted: no worker is started.
     */
    readonly signal?: AbortSignal;
}

/** Detail when the page cancelled the run. Never shown (see EngineRunOptions.signal). */
export const ENGINE_CANCELLED_DETAIL = 'stopped because the page was cleared';

/** Runs the engine on `results` in its own worker. Never throws and never rejects. */
export function runEngineInWorker(results: readonly ParseResult[], options: EngineRunOptions): Promise<EngineOutcome>
{
    return new Promise((resolve) =>
    {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let worker: WorkerHandle<ToEngineWorker> | undefined;
        const { signal } = options;

        const finish = (outcome: EngineOutcome): void =>
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
        const fail = (error: EngineFailure): void =>
            finish({ ok: false, error, detail: error === 'engine-timeout' ? ENGINE_TIMEOUT_DETAIL : ENGINE_FAILED_DETAIL });
        // A function declaration (hoisted): finish() above removes it.
        function onAbort(): void
        {
            finish({ ok: false, error: 'engine-failed', detail: ENGINE_CANCELLED_DETAIL });
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
            if (!isFromEngineWorker(data) || data.type === 'failed')
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
 * The browser's engine worker: a new worker per batch, started from
 * engine-worker.ts. Inlined in the page's script and started from a `blob:`
 * URL, so it also starts with the network switched off; see
 * createBrowserWorker in Source/email-reading/parse-worker-runner.ts for why, and for how
 * the blob: URLs are cleaned up. A fresh worker per batch: one that timed out
 * or failed must be terminated anyway, and no state from an earlier batch can
 * leak into the next.
 */
export const createBrowserEngineWorker: EngineWorkerFactory = (events) =>
    connectWorker<ToEngineWorker>(new EngineWorker({ name: 'engine-worker' }), events);
