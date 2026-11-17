// The single entry point for dropped files: one ParseResult per file, in the
// order given, whatever happens to any one file (README.md, rule R4).
//
// For each file, in order:
// 0. Bytes already handed over to an earlier worker (the same array, or a
//    view of the same buffer, given twice) -> 'tool-error' with a detail that
//    says so, not "the file is empty" (the file is not damaged).
// 1. Over MAX_FILE_BYTES -> 'too-large', before anything is read or hashed.
// 2. The file type, by name AND first bytes (file-type.ts). A file that no
//    parser takes -> 'unsupported-type' or 'corrupt'.
// 3. Over MAX_BATCH_BYTES once added to the files already accepted ->
//    'too-large', not read. Only files that go to a parser count. A smaller
//    file further down the list can still fit.
// 4. SHA-256 of the bytes (Web Crypto), so every file that was read, even
//    one that then fails, has its hash (the app's key for the file, see
//    hash.ts).
// 5. Parsed in its own Web Worker with a time limit (worker-runner.ts). A
//    .msg file is checked by cfb-check.ts before msgreader reads it.
// Files are parsed one after another, never at the same time: only one
// file's parse uses memory at any moment.
//
// The results keep the input order (the order the files were given in). A
// message without a usable date keeps `date.utcMs = null` and is flagged
// ('missing-date' or 'unparseable-date') for the preview; its place in this
// order is the fallback when messages are sorted by date.
//
// Message data stays in memory only (README.md, rule R5).

import { detectFileType } from './file-type';
import { sha256Hex } from './hash';
import { htmlToTextWithDomParser } from './html-dom';
import type { InputFile, ParseErrorCode, ParseResult } from './types';
import {
    coversWholeBuffer,
    createBrowserWorker,
    DETACHED_DETAIL,
    isDetached,
    runInWorker,
    type WorkerJob,
} from './worker-runner';

/**
 * Largest single file read: 50 MiB. Common providers cap a message at 20 to
 * 25 MB of attachments (about 34 MB as an .eml, since attachments are stored
 * as base64 text); 50 MiB leaves room for that while keeping one hostile
 * file from using up the tab's memory.
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Largest total read in one batch: 500 MiB. All files are held in memory
 * (nothing is stored on disk, README.md rule R5), so the batch needs a cap
 * too. A long correspondence is usually far below this.
 */
export const MAX_BATCH_BYTES = 500 * 1024 * 1024;

/**
 * Time limit for parsing one file in its worker: 20 seconds. A normal email
 * takes well under a second; a parser stuck on a damaged file is stopped.
 */
export const PARSE_TIMEOUT_MS = 20_000;

/** Detail for a file over MAX_FILE_BYTES. */
export const FILE_TOO_LARGE_DETAIL = 'the file is larger than 50 MB, the limit for one file';
/** Detail for a file that would take the batch over MAX_BATCH_BYTES. */
export const BATCH_TOO_LARGE_DETAIL = 'not read: the files together are larger than 500 MB, the limit for one batch';
/** Detail for an unexpected error outside the worker (a bug, never a bad file). */
const UNEXPECTED_DETAIL = 'could not be read (unexpected error)';

/** Parses one checked, hashed file (in a worker in the browser). */
export type JobRunner = (job: WorkerJob) => Promise<ParseResult>;

/** The limits, injectable so tests do not need 500 MB of data. */
export interface Limits {
    readonly maxFileBytes: number;
    readonly maxBatchBytes: number;
}

const DEFAULT_LIMITS: Limits = { maxFileBytes: MAX_FILE_BYTES, maxBatchBytes: MAX_BATCH_BYTES };

/**
 * Parses dropped files in the browser: each in its own worker, HTML bodies
 * converted on the page with DOMParser. Returns one result per file, in the
 * same order. Never rejects.
 *
 * The files' bytes are MOVED to the workers: after the call, each
 * `file.bytes` is empty (unless it was a view into a larger buffer). Read
 * each file into its own array and do not use it afterwards.
 *
 * `signal` cancels the parse ("Clear everything", see runInWorker): the
 * running worker is terminated and no new one is started.
 */
export function parseFiles(files: readonly InputFile[], signal?: AbortSignal): Promise<ParseResult[]>
{
    return parseFilesWith(files, (job) =>
        runInWorker(job, {
            createWorker: createBrowserWorker,
            // Wrapped so that the converter is always called with the default limits.
            htmlToText: (html) => htmlToTextWithDomParser(html),
            timeoutMs: PARSE_TIMEOUT_MS,
            ...(signal === undefined ? {} : { signal }),
        }),
    );
}

/** The dispatcher with the parsing step injected (unit tests use a fake). Never rejects. */
export async function parseFilesWith(
    files: readonly InputFile[],
    runJob: JobRunner,
    limits: Limits = DEFAULT_LIMITS,
): Promise<ParseResult[]>
{
    const results: ParseResult[] = [];
    let acceptedBytes = 0;
    // Buffers already moved away by runJob (whole-buffer views only). A
    // later file on one of these that now reads as empty was given twice (same
    // array, or two views of one buffer): reported as such, not as an empty
    // file. Works even where ArrayBuffer.prototype.detached does not exist.
    const handedOver = new WeakSet<ArrayBufferLike>();
    for (const file of files)
    {
        const failure = (error: ParseErrorCode, detail: string, sha256: string | null): ParseResult => ({
            ok: false,
            fileName: file.name,
            sha256,
            error,
            detail,
        });
        let sha256: string | null = null;
        try
        {
            const size = file.bytes.byteLength;
            if (isDetached(file.bytes) || (size === 0 && handedOver.has(file.bytes.buffer)))
            {
                results.push(failure('tool-error', DETACHED_DETAIL, null));
                continue;
            }
            if (size > limits.maxFileBytes)
            {
                results.push(failure('too-large', FILE_TOO_LARGE_DETAIL, null));
                continue;
            }
            const decision = detectFileType(file.name, file.bytes);
            if ('error' in decision)
            {
                results.push(failure(decision.error, decision.detail, await sha256Hex(file.bytes)));
                continue;
            }
            if (acceptedBytes + size > limits.maxBatchBytes)
            {
                results.push(failure('too-large', BATCH_TOO_LARGE_DETAIL, null));
                continue;
            }
            acceptedBytes += size;
            sha256 = await sha256Hex(file.bytes);
            // Only a buffer that is moved is recorded: a view into a larger buffer
            // is copied, so later views of that buffer still hold their bytes.
            if (coversWholeBuffer(file.bytes)) handedOver.add(file.bytes.buffer);
            results.push(await runJob({ name: file.name, kind: decision.kind, bytes: file.bytes, sha256 }));
        }
        catch
        {
            // Not expected (runInWorker never rejects); one file's bug must not
            // stop the batch. A bug in the tool, so never called a damaged file.
            results.push(failure('tool-error', UNEXPECTED_DETAIL, sha256));
        }
    }
    return results;
}

