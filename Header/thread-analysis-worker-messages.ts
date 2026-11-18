// Header: the messages between the page and the thread-analysis worker.
// Shared types only, no code (README.md, "Where things are"). The checks
// that every message really has this shape are isToThreadAnalysisWorker /
// isFromThreadAnalysisWorker in Source/worker-pipeline/thread-analysis-worker-protocol.ts.
// Used by worker-pipeline/ (thread-analysis-worker-protocol, thread-analysis-worker, thread-analysis-worker-runner)
// and file-processing.ts (ThreadAnalysisFailure).

import type { ParseResult } from './parsed-email';
import type { ThreadAnalysisResult } from './thread-analysis-result';

export interface ThreadAnalysisRequest
{
    readonly type: 'run';
    readonly results: readonly ParseResult[];
}

/** Page -> thread-analysis worker. */
export type ToThreadAnalysisWorker = ThreadAnalysisRequest;

export interface ThreadAnalysisResultMessage
{
    readonly type: 'result';
    readonly result: ThreadAnalysisResult;
}

/** The thread analysis threw (a bug, not a bad file); no details are sent. */
export interface ThreadAnalysisFailedMessage
{
    readonly type: 'failed';
}

/** Thread-analysis worker -> page. */
export type FromThreadAnalysisWorker = ThreadAnalysisResultMessage | ThreadAnalysisFailedMessage;

/** Why organizing a batch failed. */
// 'engine' is the old name of thread analysis, kept because these are error codes and translation keys.
export type ThreadAnalysisFailure = 'engine-timeout' | 'engine-failed';
