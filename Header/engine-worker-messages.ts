// Header: the messages between the page and the analysis (engine) worker.
// Shared types only, no code (README.md, "Where things are"). The checks
// that every message really has this shape are isToEngineWorker /
// isFromEngineWorker in Source/worker-pipeline/engine-protocol.ts.
// Used by worker-pipeline/ (engine-protocol, engine-worker, engine-runner)
// and file-processing.ts (EngineFailure).

import type { ParseResult } from './parsed-email';
import type { EngineResult } from './thread-analysis-result';

export interface EngineRequest
{
    readonly type: 'run';
    readonly results: readonly ParseResult[];
}

/** Page -> engine worker. */
export type ToEngineWorker = EngineRequest;

export interface EngineResultMessage
{
    readonly type: 'result';
    readonly result: EngineResult;
}

/** The engine threw (a bug, not a bad file); no details are sent. */
export interface EngineFailedMessage
{
    readonly type: 'failed';
}

/** Engine worker -> page. */
export type FromEngineWorker = EngineResultMessage | EngineFailedMessage;

/** Why organizing a batch failed. */
export type EngineFailure = 'engine-timeout' | 'engine-failed';
