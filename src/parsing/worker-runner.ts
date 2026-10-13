// The page's side of a parse worker: starts a worker for one file, converts
// HTML when the worker asks (DOMParser exists only on the page, see
// deferred-html.ts), enforces a time limit, and always terminates the worker.
//
// Every way a worker can go wrong becomes a 'corrupt' result for that file
// only, with a plain detail (README.md, rule R4):
// - it takes longer than the time limit (a parser stuck in a loop): the
//   worker is terminated -> "took too long to read (stopped)";
// - it fails: an 'error' event (for example its script could not load), a
//   'messageerror' event (a message could not be copied), a malformed
//   message, or a 'failed' message (an error thrown inside the parse)
//   -> "could not be read (worker failed)".
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
import type { FileKind } from './file-type';
import type { HtmlToTextResult } from './html-to-text';
import type { ParseResult } from './types';
import { isFromWorker, type ToWorker } from './worker-protocol';

/** Detail of a file whose worker was stopped at the time limit. */
export const TIMEOUT_DETAIL = 'took too long to read (stopped)';
/** Detail of a file whose worker failed (error event, bad message, ...). */
export const WORKER_FAILED_DETAIL = 'could not be read (worker failed)';
/**
 * Detail of a file whose bytes were already moved to an earlier worker (the
 * same array, or another view of the same buffer, given twice). Not damage:
 * reading the file again fixes it.
 */
export const DETACHED_DETAIL = 'the file data was already handed over; read the file again';

/**
 * True if the buffer under `bytes` has been moved away (transferred), so the
 * view now reads as empty. Uses ArrayBuffer.prototype.detached where the
 * browser has it; elsewhere this is false and callers use their own record
 * of what they handed over (see parse-files.ts).
 */
export function isDetached(bytes: Uint8Array): boolean {
  const buffer: unknown = bytes.buffer;
  return buffer instanceof ArrayBuffer && 'detached' in buffer && buffer.detached === true;
}

/**
 * What the page needs from a worker. `M` is the type of the messages the
 * page sends: parse requests here, engine requests for the engine worker
 * (src/pipeline/engine-runner.ts), which reuses connectWorker below.
 */
export interface WorkerHandle<M = ToWorker> {
  send(message: M, transfer: Transferable[]): void;
  terminate(): void;
}

/** What the worker reports back to the page. */
export interface WorkerEvents {
  /** A message from the worker (still unchecked). */
  message(data: unknown): void;
  /** An 'error' or 'messageerror' event. */
  failure(): void;
}

/** Starts a worker and connects its events. May throw (then the file fails, not the batch). */
export type WorkerFactory = (events: WorkerEvents) => WorkerHandle;

/** One file, checked and hashed by the dispatcher (parse-files.ts), ready for a worker. */
export interface WorkerJob {
  readonly name: string;
  readonly kind: FileKind;
  /** MOVED to the worker: after the call this array is empty (detached), unless it was a view into a larger buffer. */
  readonly bytes: Uint8Array;
  /** SHA-256 of `bytes`, for results the worker could not produce (timeout, failure). */
  readonly sha256: string;
}

export interface RunOptions {
  readonly createWorker: WorkerFactory;
  /** The real converter, run on the page (htmlToTextWithDomParser in the browser). */
  readonly htmlToText: (html: string) => HtmlToTextResult;
  /**
   * Time limit for each stretch of work inside the worker: the parse, and
   * (if HTML had to be converted) the second parse. The time the page spends
   * converting HTML is not counted: the page cannot be stopped anyway.
   */
  readonly timeoutMs: number;
}

/** Parses one file in its own worker. Never throws and never rejects. */
export function runInWorker(job: WorkerJob, options: RunOptions): Promise<ParseResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let worker: WorkerHandle | undefined;

    const finish = (result: ParseResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Terminated in every case: a finished worker holds the file's data,
      // a stuck one holds the CPU.
      try {
        worker?.terminate();
      } catch {
        // Nothing more to do: the result is what matters.
      }
      resolve(result);
    };
    const fail = (detail: string): void =>
      finish({ ok: false, error: 'corrupt', detail, fileName: job.name, sha256: job.sha256 });
    const startClock = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(TIMEOUT_DETAIL), options.timeoutMs);
    };

    const onMessage = (data: unknown): void => {
      if (settled) return;
      if (!isFromWorker(data) || data.type === 'failed') {
        fail(WORKER_FAILED_DETAIL);
        return;
      }
      if (data.type === 'result') {
        finish(data.result);
        return;
      }
      // The worker waits for HTML conversions: the clock stops while the page works.
      clearTimeout(timer);
      const outcomes = convertHtmlList(data.htmls, options.htmlToText);
      startClock();
      try {
        worker?.send({ type: 'conversions', outcomes }, []);
      } catch {
        fail(WORKER_FAILED_DETAIL);
      }
    };

    if (isDetached(job.bytes)) {
      // Nothing left to send; say so instead of "the file is empty" or a
      // worker failure, which would read like a damaged file.
      fail(DETACHED_DETAIL);
      return;
    }
    try {
      worker = options.createWorker({ message: onMessage, failure: () => fail(WORKER_FAILED_DETAIL) });
      const bytes = ownedCopy(job.bytes);
      startClock();
      worker.send({ type: 'parse', name: job.name, kind: job.kind, bytes }, [bytes.buffer]);
    } catch {
      fail(WORKER_FAILED_DETAIL);
    }
  });
}

/**
 * The bytes in a buffer of their own, ready to be moved to the worker.
 * A view that covers its whole buffer is moved as it is (no copy; the
 * caller's array becomes empty). A view into a larger buffer is copied first,
 * so the rest of that buffer is never moved away from its owner.
 */
function ownedCopy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (coversWholeBuffer(bytes)) return new Uint8Array(bytes.buffer);
  return bytes.slice();
}

/**
 * True when these bytes will be MOVED to the worker (not copied): a view
 * that covers the whole of a plain ArrayBuffer.
 */
export function coversWholeBuffer(bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer> {
  const { buffer } = bytes;
  return buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength;
}

/**
 * The browser's worker: one new module worker per file, built by Vite from
 * parse-worker.ts into a separate same-origin script file (allowed by the
 * CSP's `worker-src 'self'`; never a blob: or data: URL).
 *
 * Why one worker per file instead of one reused worker: a worker that timed
 * out or failed must be terminated anyway, and a fresh worker per file means
 * no memory or half-finished state from one file can affect the next. The
 * cost, starting a worker (tens of milliseconds), is small next to reading a
 * file.
 */
export const createBrowserWorker: WorkerFactory = (events) =>
  connectWorker(new Worker(new URL('./parse-worker.ts', import.meta.url), { type: 'module' }), events);

/** Connects a started browser Worker to `events` and wraps it as a WorkerHandle. */
export function connectWorker<M = ToWorker>(worker: Worker, events: WorkerEvents): WorkerHandle<M> {
  worker.addEventListener('message', (event: MessageEvent<unknown>) => events.message(event.data));
  worker.addEventListener('error', (event) => {
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
