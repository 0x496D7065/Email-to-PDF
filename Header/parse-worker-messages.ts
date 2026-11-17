// Header: the messages between the page and the reading worker, and the
// handle that starts a worker. Shared types only, no code (README.md, "Where
// things are"). The checks that every message really has this shape are
// isToWorker / isFromWorker in Source/email-reading/worker-protocol.ts.
// Used by email-reading/ (worker-protocol, parse-worker, worker-runner,
// parse-files) and worker-pipeline/ (its runners reuse WorkerHandle and
// WorkerEvents; read-files and process-files use Limits).

import type { ParseResult } from './parsed-email';

export interface ParseRequest
{
    readonly type: 'parse';
    readonly name: string;
    readonly kind: FileKind;
    readonly bytes: Uint8Array;
}

export interface ConversionsReply
{
    readonly type: 'conversions';
    readonly outcomes: readonly ConversionOutcome[];
}

/** Page -> worker. */
export type ToWorker = ParseRequest | ConversionsReply;

export interface HtmlRequest
{
    readonly type: 'html';
    readonly htmls: readonly string[];
}

export interface ResultMessage
{
    readonly type: 'result';
    readonly result: ParseResult;
}

/** The worker hit an error it could not turn into a result (a bug, not a bad file). */
export interface FailedMessage
{
    readonly type: 'failed';
}

/** Worker -> page. */
export type FromWorker = HtmlRequest | ResultMessage | FailedMessage;

/** The two formats the tool reads. */
export type FileKind = 'eml' | 'msg';

/** One HTML body converted on the page, or why it could not be. */
export type ConversionOutcome =
    | { readonly ok: true; readonly text: string; readonly truncated: boolean }
    /** `reason` is the converter's own reason, without the "HTML body could not be converted: " prefix. */
    | { readonly ok: false; readonly reason: string };

/**
 * What the page needs from a worker. `M` is the type of the messages the
 * page sends: parse requests for the reading worker, engine requests for the engine worker
 * (Source/worker-pipeline/engine-runner.ts), which reuses connectWorker (Source/email-reading/worker-runner.ts).
 */
export interface WorkerHandle<M = ToWorker>
{
    send(message: M, transfer: Transferable[]): void;
    terminate(): void;
}

/** What the worker reports back to the page. */
export interface WorkerEvents
{
    /** A message from the worker (still unchecked). */
    message(data: unknown): void;
    /** An 'error' or 'messageerror' event. */
    failure(): void;
}

/** The limits, injectable so tests do not need 500 MB of data. */
export interface Limits
{
    readonly maxFileBytes: number;
    readonly maxBatchBytes: number;
}
