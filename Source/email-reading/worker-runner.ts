// The page's side of a parse worker: starts a worker for one file, converts
// HTML when the worker asks (DOMParser exists only on the page, see
// deferred-html.ts), enforces a time limit, and always terminates the worker.
//
// Every way a worker can go wrong becomes a failed result for that file
// only, with a plain detail (README.md, rule R4). None of them is reported
// as 'corrupt' (a damaged file): the parsers report real damage themselves,
// inside a normal 'result' message.
// - it takes longer than the time limit (a parser stuck in a loop, or a very
//   slow computer): the worker is terminated -> 'timeout';
// - it cannot be started (the factory throws) -> 'tool-error';
// - it fails: an 'error' event (for example its script could not run), a
//   'messageerror' event (a message could not be copied), a malformed
//   message, or a 'failed' message (an error thrown inside the parse, which
//   the adapters never do for a bad file) -> 'tool-error'.
// The page can also cancel a parse (its `signal`, for "Clear everything"):
// the worker is terminated at once and anything it sends later is ignored.
//
// Known limit: memory. Typed-array allocations that are too large and
// array-length overflows become catchable errors inside the worker (so a
// 'failed' message). A real heap exhaustion (many objects) fires no event the
// page can count on and can still freeze, then kill, the whole tab before the
// time limit. That is why the .msg structure check (cfb-check.ts) runs
// before msgreader: it rejects the files known to make msgreader grow memory
// without bound.
//
// The worker itself is hidden behind WorkerFactory so that this logic
// (timeouts, error events, message order) is unit tested with a fake worker.

import { convertHtmlList } from './deferred-html';
import type { HtmlToTextResult } from './html-to-text';
import ParseWorker from './parse-worker?worker&inline';
import { isFromWorker } from './worker-protocol';
import type { FileKind, ToWorker, WorkerEvents, WorkerHandle } from '../../Header/parse-worker-messages';
import type { ParseResult } from '../../Header/parsed-email';

/** Detail of a file whose worker was stopped at the time limit ('timeout'). */
export const TIMEOUT_DETAIL = 'took too long to read (stopped)';
/** Detail of a file whose worker could not be created ('tool-error'). */
export const WORKER_START_DETAIL = 'the reading step could not start (worker not started)';
/** Detail of a file whose worker failed: error event, bad message, ... ('tool-error'). */
export const WORKER_FAILED_DETAIL = 'the reading step stopped unexpectedly (worker failed)';
/**
 * Detail of a file whose bytes were already moved to an earlier worker (the
 * same array, or another view of the same buffer, given twice). Not damage:
 * reading the file again fixes it ('tool-error').
 */
export const DETACHED_DETAIL = 'the file data was already handed over; read the file again';
/**
 * Detail of a file whose parse was stopped because the page cancelled the
 * batch ("Clear everything"). Never shown: the page throws a cancelled
 * batch's results away ('tool-error').
 */
export const CANCELLED_DETAIL = 'stopped because the page was cleared';

/**
 * True if the buffer under `bytes` has been moved away (transferred), so the
 * view now reads as empty. Uses ArrayBuffer.prototype.detached where the
 * browser has it; elsewhere this is false and callers use their own record
 * of what they handed over (see parse-files.ts).
 */
export function isDetached(bytes: Uint8Array): boolean
{
    const buffer: unknown = bytes.buffer;
    return buffer instanceof ArrayBuffer && 'detached' in buffer && buffer.detached === true;
}

/** Starts a worker and connects its events. May throw (then the file fails, not the batch). */
export type WorkerFactory = (events: WorkerEvents) => WorkerHandle;

/** One file, checked and hashed by the dispatcher (parse-files.ts), ready for a worker. */
export interface WorkerJob
{
    readonly name: string;
    readonly kind: FileKind;
    /** MOVED to the worker: after the call this array is empty (detached), unless it was a view into a larger buffer. */
    readonly bytes: Uint8Array;
    /** SHA-256 of `bytes`, for results the worker could not produce (timeout, failure). */
    readonly sha256: string;
}

export interface RunOptions
{
    readonly createWorker: WorkerFactory;
    /** The real converter, run on the page (htmlToTextWithDomParser in the browser). */
    readonly htmlToText: (html: string) => HtmlToTextResult;
    /**
     * Time limit for each stretch of work inside the worker: the parse, and
     * (if HTML had to be converted) the second parse. The time the page spends
     * converting HTML is not counted: the page cannot be stopped anyway.
     */
    readonly timeoutMs: number;
    /**
     * Stops the parse ("Clear everything"): the worker is terminated at once
     * and the result is a 'tool-error' with CANCELLED_DETAIL. Anything the
     * worker sends afterwards is ignored. Already aborted: no worker is started.
     */
    readonly signal?: AbortSignal;
}

/** Parses one file in its own worker. Never throws and never rejects. */
export function runInWorker(job: WorkerJob, options: RunOptions): Promise<ParseResult>
{
    return new Promise((resolve) =>
    {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let worker: WorkerHandle | undefined;
        const { signal } = options;

        const finish = (result: ParseResult): void =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            // Terminated in every case: a finished worker holds the file's data,
            // a stuck one holds the CPU.
            try
            {
                worker?.terminate();
            }
            catch
            {
                // Nothing more to do: the result is what matters.
            }
            resolve(result);
        };
        const fail = (error: 'timeout' | 'tool-error', detail: string): void =>
            finish({ ok: false, error, detail, fileName: job.name, sha256: job.sha256 });
        const toolError = (detail: string = WORKER_FAILED_DETAIL): void => fail('tool-error', detail);
        // A function declaration (hoisted): finish() above removes it.
        function onAbort(): void
        {
            toolError(CANCELLED_DETAIL);
        }
        const startClock = (): void =>
        {
            clearTimeout(timer);
            timer = setTimeout(() => fail('timeout', TIMEOUT_DETAIL), options.timeoutMs);
        };

        const onMessage = (data: unknown): void =>
        {
            if (settled)
            {
                return;
            }
            if (!isFromWorker(data) || data.type === 'failed')
            {
                toolError();
                return;
            }
            if (data.type === 'result')
            {
                finish(data.result);
                return;
            }
            // The worker waits for HTML conversions: the clock stops while the page works.
            clearTimeout(timer);
            const outcomes = convertHtmlList(data.htmls, options.htmlToText);
            startClock();
            try
            {
                worker?.send({ type: 'conversions', outcomes }, []);
            }
            catch
            {
                toolError();
            }
        };

        if (signal?.aborted === true)
        {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        if (isDetached(job.bytes))
        {
            // Nothing left to send; say so instead of "the file is empty" or a
            // worker failure, which would read like a damaged file.
            toolError(DETACHED_DETAIL);
            return;
        }
        try
        {
            worker = options.createWorker({ message: onMessage, failure: () => toolError() });
        }
        catch
        {
            toolError(WORKER_START_DETAIL);
            return;
        }
        try
        {
            const bytes = ownedCopy(job.bytes);
            startClock();
            worker.send({ type: 'parse', name: job.name, kind: job.kind, bytes }, [bytes.buffer]);
        }
        catch
        {
            toolError();
        }
    });
}

/**
 * The bytes in a buffer of their own, ready to be moved to the worker.
 * A view that covers its whole buffer is moved as it is (no copy; the
 * caller's array becomes empty). A view into a larger buffer is copied first,
 * so the rest of that buffer is never moved away from its owner.
 */
function ownedCopy(bytes: Uint8Array): Uint8Array<ArrayBuffer>
{
    if (coversWholeBuffer(bytes))
    {
        return new Uint8Array(bytes.buffer);
    }
    return bytes.slice();
}

/**
 * True when these bytes will be MOVED to the worker (not copied): a view
 * that covers the whole of a plain ArrayBuffer.
 */
export function coversWholeBuffer(bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer>
{
    const { buffer } = bytes;
    return buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength;
}

/**
 * The browser's worker: one new worker per file, started from parse-worker.ts.
 *
 * Why inline (`?worker&inline`): the tool must keep working after the
 * network is switched off, right after the page loaded (that is how users
 * check the privacy promise). A worker in its own script file is fetched
 * from the server each time one starts, which fails offline. With
 * `?worker&inline`, Vite bundles the worker's code as a text string inside
 * the page's own script, so it is already in memory. Each call puts that
 * string in a Blob and starts the worker from a `blob:` URL (allowed by the
 * CSP's `worker-src 'self' blob:`). A blob worker also takes the page's own
 * CSP, header and <meta> alike, so `connect-src 'none'` applies inside it.
 *
 * Blob URL lifetime: Vite keeps ONE Blob per worker type for the page's life
 * (it holds only the tool's own code, never email data) and makes a fresh
 * blob: URL for each worker. The worker revokes its own URL as its very first
 * statement, and the page revokes it if the worker fails to start, so no URL
 * piles up per file. (Vite's wrapper falls back to a data: URL if the blob:
 * URL throws; our CSP blocks data: workers, so that path can only end in a
 * 'tool-error' result, never in loaded code.)
 *
 * Why one worker per file instead of one reused worker: a worker that timed
 * out or failed must be terminated anyway, and a fresh worker per file means
 * no memory or half-finished state from one file can affect the next. The
 * cost, starting a worker (tens of milliseconds), is small next to reading a
 * file.
 */
export const createBrowserWorker: WorkerFactory = (events) =>
    // The name shows in DevTools (and lets the browser tests tell workers apart).
    connectWorker(new ParseWorker({ name: 'parse-worker' }), events);

/** Connects a started browser Worker to `events` and wraps it as a WorkerHandle. */
export function connectWorker<M = ToWorker>(worker: Worker, events: WorkerEvents): WorkerHandle<M>
{
    worker.addEventListener('message', (event: MessageEvent<unknown>) => events.message(event.data));
    worker.addEventListener('error', (event) =>
    {
        // Handled here: keeps the browser from also reporting it as an uncaught error.
        event.preventDefault();
        events.failure();
    });
    worker.addEventListener('messageerror', () => events.failure());
    return {
        send: (message, transfer) => worker.postMessage(message, transfer),
        terminate: () => worker.terminate(),
    };
}
