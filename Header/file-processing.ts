// Header: processing a batch of dropped files (read, parse, analyse), as the
// page sees it. Shared types only, no code (README.md, "Where things are").
// worker-pipeline/ (process-files, read-files) does the work; web-page/
// (add-files, page, preview, review) starts it and shows the result.

import type { ThreadAnalysisFailure } from './thread-analysis-worker-messages';
import type { ParseResult } from './parsed-email';
import type { EngineResult } from './thread-analysis-result';

/**
 * Why a whole batch has no result. 'unexpected' is a bug in process-files.ts,
 * never a bad file. 'cancelled': the page stopped the batch (its `signal`,
 * for "Clear everything").
 */
export type ProcessErrorCode = ThreadAnalysisFailure | 'unexpected' | 'cancelled';

/**
 * Progress for the UI: 'reading' after each file is read and parsed
 * (filesDone goes from 0 to filesTotal), then 'organizing' once while the
 * engine runs.
 */
export interface ProcessProgress
{
    readonly stage: 'reading' | 'organizing';
    readonly filesDone: number;
    readonly filesTotal: number;
}

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

export interface ProcessOptions
{
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

/** The part of a browser File that read-files.ts uses (a real File fits; tests use fakes). */
export interface FileLike
{
    readonly name: string;
    readonly size: number;
    arrayBuffer(): Promise<ArrayBuffer>;
}
