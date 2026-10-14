// The one call the preview UI makes: dropped files in, organized messages
// out. Non-visual plumbing only.
//
// For each file, in order (one at a time, so only one file's bytes are in
// memory at any moment):
// 1. read it safely (read-files.ts): the size limits are checked BEFORE the
//    file is loaded;
// 2. parse it in its own Web Worker (parseFiles, src/parsing/parse-files.ts),
//    which moves the bytes to the worker and so frees them on the page;
// 3. report progress (files done / total).
// Then the engine organizes every result in its own worker
// (engine-runner.ts): de-duplication, order, folds.
//
// Failures (README.md, rule R4):
// - one file that cannot be read or parsed is a failed result for that file
//   only, listed by the engine like any other failed file;
// - if the engine worker times out or fails, the whole batch gets a clear
//   error (ok: false), with the parse results kept so the preview can still
//   say what was read. This function never throws and never rejects, so the
//   page always gets something to show.
//
// Cancelling ("Clear everything", src/ui/page.ts): the `signal` option
// terminates the running worker, stops the batch and drops what it read.
//
// Everything stays in memory only (README.md, rule R5).

import type { EngineResult } from '../engine/engine';
import { parseFiles, type Limits, MAX_BATCH_BYTES, MAX_FILE_BYTES } from '../parsing/parse-files';
import type { InputFile, ParseResult } from '../parsing/types';
import { createBrowserEngineWorker, ENGINE_TIMEOUT_MS, runEngineInWorker, type EngineFailure, type EngineOutcome } from './engine-runner';
import { createFileReader, type FileLike } from './read-files';

/**
 * Why a whole batch has no result. 'unexpected' is a bug in this module,
 * never a bad file. 'cancelled': the page stopped the batch (its `signal`,
 * for "Clear everything").
 */
export type ProcessErrorCode = EngineFailure | 'unexpected' | 'cancelled';

/** Detail for an unexpected error (a bug, never a bad file). */
export const UNEXPECTED_BATCH_DETAIL = 'the files could not be processed (unexpected error)';
/** Detail for a batch the page cancelled. */
export const CANCELLED_BATCH_DETAIL = 'stopped because the page was cleared';
/** Detail for one file that hit an unexpected error outside its worker. */
export const UNEXPECTED_FILE_DETAIL = 'could not be read (unexpected error)';

/** The outcome of one batch. */
export type ProcessResult =
  | { readonly ok: true; readonly engine: EngineResult }
  | {
      readonly ok: false;
      readonly error: ProcessErrorCode;
      /** Plain words for the preview. */
      readonly detail: string;
      /** One result per file, in input order, as far as they were produced (may be empty). */
      readonly parsed: readonly ParseResult[];
    };

/**
 * Progress for the UI: 'reading' after each file is read and parsed
 * (filesDone goes from 0 to filesTotal), then 'organizing' once while the
 * engine runs.
 */
export interface ProcessProgress {
  readonly stage: 'reading' | 'organizing';
  readonly filesDone: number;
  readonly filesTotal: number;
}

export interface ProcessOptions {
  /** Called as the batch advances. An error thrown by it is ignored. Never called once `signal` is aborted. */
  readonly onProgress?: (progress: ProcessProgress) => void;
  /**
   * Cancels the batch ("Clear everything"): the running worker (parse or
   * engine) is terminated, no further file is read, and the batch resolves
   * soon after with { ok: false, error: 'cancelled' } and no parse results.
   * A file the browser is still reading cannot be interrupted; its bytes are
   * dropped as soon as the read ends, without being parsed.
   */
  readonly signal?: AbortSignal;
}

/** The replaceable steps (unit and browser tests pass fakes or misbehaving workers). */
export interface ProcessSteps {
  readonly parse: (files: readonly InputFile[], signal?: AbortSignal) => Promise<ParseResult[]>;
  readonly organize: (results: readonly ParseResult[], signal?: AbortSignal) => Promise<EngineOutcome>;
  readonly limits: Limits;
}

const BROWSER_STEPS: ProcessSteps = {
  parse: parseFiles,
  organize: (results, signal) =>
    runEngineInWorker(results, { createWorker: createBrowserEngineWorker, timeoutMs: ENGINE_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) }),
  limits: { maxFileBytes: MAX_FILE_BYTES, maxBatchBytes: MAX_BATCH_BYTES },
};

/** The result of a cancelled batch: nothing from it is kept. */
function cancelledResult(): ProcessResult {
  return { ok: false, error: 'cancelled', detail: CANCELLED_BATCH_DETAIL, parsed: [] };
}

/** Processes dropped files in the browser (see the top of this file). Never rejects. */
export function processFiles(files: readonly FileLike[], options: ProcessOptions = {}): Promise<ProcessResult> {
  return processFilesWith(files, BROWSER_STEPS, options);
}

/** processFiles with the steps injected. Never rejects. */
export async function processFilesWith(files: readonly FileLike[], steps: ProcessSteps, options: ProcessOptions = {}): Promise<ProcessResult> {
  const parsed: ParseResult[] = [];
  const { signal } = options;
  const cancelled = (): boolean => signal?.aborted === true;
  try {
    const total = files.length;
    const report = (stage: ProcessProgress['stage'], filesDone: number): void => {
      // Defensive: the callers below already return once cancelled.
      if (cancelled()) return;
      try {
        options.onProgress?.({ stage, filesDone, filesTotal: total });
      } catch {
        // A broken progress display must not stop the batch.
      }
    };
    if (cancelled()) return cancelledResult();
    report('reading', 0);
    const read = createFileReader(steps.limits);
    for (const file of files) {
      const result = await readAndParse(file, read, steps, signal);
      if (cancelled()) return cancelledResult();
      parsed.push(result);
      report('reading', parsed.length);
    }
    report('organizing', total);
    const outcome = await steps.organize(parsed, signal);
    if (cancelled()) return cancelledResult();
    if (outcome.ok) return { ok: true, engine: outcome.result };
    return { ok: false, error: outcome.error, detail: outcome.detail, parsed };
  } catch {
    if (cancelled()) return cancelledResult();
    return { ok: false, error: 'unexpected', detail: UNEXPECTED_BATCH_DETAIL, parsed };
  }
}

/** One file: read, then parse. Never rejects: an unexpected error fails this file only. */
async function readAndParse(
  file: FileLike,
  read: ReturnType<typeof createFileReader>,
  steps: ProcessSteps,
  signal: AbortSignal | undefined,
): Promise<ParseResult> {
  let name = '';
  try {
    name = typeof file.name === 'string' ? file.name : '';
    const outcome = await read(file);
    if (!outcome.ok) return outcome.result;
    // Cancelled while the browser was reading: the bytes are dropped unparsed.
    if (signal?.aborted === true) return { ok: false, fileName: name, sha256: null, error: 'tool-error', detail: CANCELLED_BATCH_DETAIL };
    // One file per call: its bytes go to a worker and are freed here before
    // the next file is read.
    const [result] = await steps.parse([outcome.input], signal);
    if (result === undefined) throw new Error('no result');
    return result;
  } catch {
    // A bug in the tool, never a bad file: not reported as damaged.
    return { ok: false, fileName: name, sha256: null, error: 'tool-error', detail: UNEXPECTED_FILE_DETAIL };
  }
}
