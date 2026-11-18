// The messages between the page and the thread-analysis worker, and the worker's side
// of the conversation.
//
// One worker organizes one batch:
//   page   -> worker: { type: 'run', results }    (one ParseResult per file)
//   worker -> page:   { type: 'result', result }  (or { type: 'failed' })
// Then the page terminates the worker. See thread-analysis-worker-runner.ts for the page's
// side and thread-analysis-worker.ts for why the thread analysis runs in a worker.
//
// Messages are copied by the browser (structured clone): plain data only.
// The analysis result is plain data on purpose (see Source/thread-analysis/analyze-thread.ts),
// including the messages rebuilt from quoted text and the timeline (task
// 7.5: `reconstructed`, `timeline`, `reconstructionWarnings`).
// Nothing is stored anywhere (README.md, rule R5).

import { analyzeThread } from '../thread-analysis/analyze-thread';
import type { FromThreadAnalysisWorker, ToThreadAnalysisWorker } from '../../Header/thread-analysis-worker-messages';
import type { ParseResult } from '../../Header/parsed-email';
import type { ThreadAnalysisResult } from '../../Header/thread-analysis-result';

function isRecord(value: unknown): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null;
}

/** True if `data` is a well-formed page -> thread-analysis worker message. */
export function isToThreadAnalysisWorker(data: unknown): data is ToThreadAnalysisWorker
{
    return (
        isRecord(data) &&
        data.type === 'run' &&
        Array.isArray(data.results) &&
        (data.results as readonly unknown[]).every((r) => isRecord(r) && typeof r.ok === 'boolean')
    );
}

/**
 * True if `data` is a well-formed thread-analysis worker -> page message. The result
 * is checked for its overall shape (the lists and counts the preview reads
 * first, and the lists of rebuilt messages, timeline and rebuild warnings);
 * the worker runs our own code, so this guards against bugs and stray
 * messages, not against a hostile worker.
 */
export function isFromThreadAnalysisWorker(data: unknown): data is FromThreadAnalysisWorker
{
    if (!isRecord(data))
    {
        return false;
    }
    if (data.type === 'failed')
    {
        return true;
    }
    if (data.type !== 'result' || !isRecord(data.result))
    {
        return false;
    }
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
 * worker receives. `post` sends a message to the page; `analyze` is the thread analysis
 * (tests pass a broken one). Kept apart from thread-analysis-worker.ts so it runs in
 * unit tests without a browser.
 */
export function createThreadAnalysisWorkerSide(
    post: (message: FromThreadAnalysisWorker) => void,
    analyze: (results: readonly ParseResult[]) => ThreadAnalysisResult = analyzeThread,
): (data: unknown) => void
{
    let started = false;
    return (data) =>
    {
        if (!isToThreadAnalysisWorker(data))
        {
            return;
        }
        // One batch per worker: a second request is ignored.
        if (started)
        {
            return;
        }
        started = true;
        let result: ThreadAnalysisResult;
        try
        {
            result = analyze(data.results);
        }
        catch
        {
            post({ type: 'failed' });
            return;
        }
        try
        {
            post({ type: 'result', result });
        }
        catch
        {
            // The result could not be copied to the page (should never happen:
            // it is plain data). Say so instead of leaving the page waiting.
            post({ type: 'failed' });
        }
    };
}
