// The page's side of the engine worker: starts a worker for one batch, sends
// it the parse results, enforces a time limit, and always terminates the
// worker. Same patterns as the parse workers (src/parsing/worker-runner.ts).
//
// Every way the worker can go wrong becomes a batch-level failure with a
// plain detail, never a thrown error and never a page that waits forever:
// - it takes longer than ENGINE_TIMEOUT_MS: terminated -> 'engine-timeout';
// - it fails: an 'error' event (for example its script could not load), a
//   'messageerror' event, a malformed message, a 'failed' message (the engine
//   threw), or the worker could not be started or sent the request
//   -> 'engine-failed'.
// Anything the worker sends after that is ignored.
//
// The worker is hidden behind a factory so this logic is unit tested with a
// fake worker.

import type { EngineResult } from '../engine/engine';
import type { ParseResult } from '../parsing/types';
import { connectWorker, type WorkerEvents, type WorkerHandle } from '../parsing/worker-runner';
import { isFromEngineWorker, type ToEngineWorker } from './engine-protocol';

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

/** Why organizing a batch failed. */
export type EngineFailure = 'engine-timeout' | 'engine-failed';

/** The engine's result, or why there is none. */
export type EngineOutcome =
  | { readonly ok: true; readonly result: EngineResult }
  | { readonly ok: false; readonly error: EngineFailure; readonly detail: string };

/** Starts an engine worker and connects its events. May throw (then the batch fails, nothing else). */
export type EngineWorkerFactory = (events: WorkerEvents) => WorkerHandle<ToEngineWorker>;

export interface EngineRunOptions {
  readonly createWorker: EngineWorkerFactory;
  readonly timeoutMs: number;
}

/** Runs the engine on `results` in its own worker. Never throws and never rejects. */
export function runEngineInWorker(results: readonly ParseResult[], options: EngineRunOptions): Promise<EngineOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let worker: WorkerHandle<ToEngineWorker> | undefined;

    const finish = (outcome: EngineOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Terminated in every case: a finished worker holds a copy of every
      // message, a stuck one holds the CPU.
      try {
        worker?.terminate();
      } catch {
        // Nothing more to do: the outcome is what matters.
      }
      resolve(outcome);
    };
    const fail = (error: EngineFailure): void =>
      finish({ ok: false, error, detail: error === 'engine-timeout' ? ENGINE_TIMEOUT_DETAIL : ENGINE_FAILED_DETAIL });

    const onMessage = (data: unknown): void => {
      if (settled) return;
      if (!isFromEngineWorker(data) || data.type === 'failed') {
        fail('engine-failed');
        return;
      }
      finish({ ok: true, result: data.result });
    };

    try {
      worker = options.createWorker({ message: onMessage, failure: () => fail('engine-failed') });
      timer = setTimeout(() => fail('engine-timeout'), options.timeoutMs);
      // Copied, not moved: the parse results are plain objects (no buffers).
      worker.send({ type: 'run', results }, []);
    } catch {
      fail('engine-failed');
    }
  });
}

/**
 * The browser's engine worker: a new module worker per batch, built by Vite
 * from engine-worker.ts into a separate same-origin script file (allowed by
 * the CSP's `worker-src 'self'`; never a blob: or data: URL). A fresh worker
 * per batch: one that timed out or failed must be terminated anyway, and no
 * state from an earlier batch can leak into the next.
 */
export const createBrowserEngineWorker: EngineWorkerFactory = (events) =>
  connectWorker<ToEngineWorker>(new Worker(new URL('./engine-worker.ts', import.meta.url), { type: 'module' }), events);
