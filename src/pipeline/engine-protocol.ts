// The messages between the page and the engine worker, and the worker's side
// of the conversation.
//
// One worker organizes one batch:
//   page   -> worker: { type: 'run', results }    (one ParseResult per file)
//   worker -> page:   { type: 'result', result }  (or { type: 'failed' })
// Then the page terminates the worker. See engine-runner.ts for the page's
// side and engine-worker.ts for why the engine runs in a worker.
//
// Messages are copied by the browser (structured clone): plain data only.
// The engine's result is plain data on purpose (see src/engine/engine.ts),
// including the messages rebuilt from quoted text and the timeline (task
// 7.5: `reconstructed`, `timeline`, `reconstructionWarnings`).
// Nothing is stored anywhere (README.md, rule R5).

import { runEngine, type EngineResult } from '../engine/engine';
import type { ParseResult } from '../parsing/types';

export interface EngineRequest {
  readonly type: 'run';
  readonly results: readonly ParseResult[];
}

/** Page -> engine worker. */
export type ToEngineWorker = EngineRequest;

export interface EngineResultMessage {
  readonly type: 'result';
  readonly result: EngineResult;
}

/** The engine threw (a bug, not a bad file); no details are sent. */
export interface EngineFailedMessage {
  readonly type: 'failed';
}

/** Engine worker -> page. */
export type FromEngineWorker = EngineResultMessage | EngineFailedMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** True if `data` is a well-formed page -> engine worker message. */
export function isToEngineWorker(data: unknown): data is ToEngineWorker {
  return (
    isRecord(data) &&
    data.type === 'run' &&
    Array.isArray(data.results) &&
    (data.results as readonly unknown[]).every((r) => isRecord(r) && typeof r.ok === 'boolean')
  );
}

/**
 * True if `data` is a well-formed engine worker -> page message. The result
 * is checked for its overall shape (the lists and counts the preview reads
 * first, and the lists of rebuilt messages, timeline and rebuild warnings);
 * the worker runs our own code, so this guards against bugs and stray
 * messages, not against a hostile worker.
 */
export function isFromEngineWorker(data: unknown): data is FromEngineWorker {
  if (!isRecord(data)) return false;
  if (data.type === 'failed') return true;
  if (data.type !== 'result' || !isRecord(data.result)) return false;
  const { messages, failed, counts, positionByIndex, reconstructed, timeline, reconstructionWarnings } = data.result;
  return (
    Array.isArray(messages) &&
    Array.isArray(failed) &&
    isRecord(counts) &&
    Array.isArray(positionByIndex) &&
    Array.isArray(reconstructed) &&
    Array.isArray(timeline) &&
    Array.isArray(reconstructionWarnings)
  );
}

/**
 * The worker's side: returns the function to call with each message the
 * worker receives. `post` sends a message to the page; `run` is the engine
 * (tests pass a broken one). Kept apart from engine-worker.ts so it runs in
 * unit tests without a browser.
 */
export function createEngineWorkerSide(
  post: (message: FromEngineWorker) => void,
  run: (results: readonly ParseResult[]) => EngineResult = runEngine,
): (data: unknown) => void {
  let started = false;
  return (data) => {
    if (!isToEngineWorker(data)) return;
    // One batch per worker: a second request is ignored.
    if (started) return;
    started = true;
    let result: EngineResult;
    try {
      result = run(data.results);
    } catch {
      post({ type: 'failed' });
      return;
    }
    try {
      post({ type: 'result', result });
    } catch {
      // The result could not be copied to the page (should never happen:
      // it is plain data). Say so instead of leaving the page waiting.
      post({ type: 'failed' });
    }
  };
}
