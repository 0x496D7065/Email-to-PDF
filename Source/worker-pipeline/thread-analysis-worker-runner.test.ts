// Unit tests for the page's side of the thread-analysis worker (thread-analysis-worker-runner.ts),
// with a FAKE worker: time limit, terminate on every path, error events, bad
// and late messages. The real worker is checked in Chromium by
// Helper/Test/browser-tests/parse-files.spec.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import {
    THREAD_ANALYSIS_CANCELLED_DETAIL,
    THREAD_ANALYSIS_FAILED_DETAIL,
    THREAD_ANALYSIS_TIMEOUT_DETAIL,
    THREAD_ANALYSIS_TIMEOUT_MS,
    runThreadAnalysisInWorker,
    type ThreadAnalysisOutcome,
    type ThreadAnalysisWorkerFactory,
} from './thread-analysis-worker-runner';
import type { ToThreadAnalysisWorker } from '../../Header/thread-analysis-worker-messages';
import type { WorkerEvents } from '../../Header/parse-worker-messages';
import type { ParseResult } from '../../Header/parsed-email';

const TIMEOUT_MS = 1000;
const RESULTS: ParseResult[] = [{ ok: false, fileName: 'notes.txt', sha256: null, error: 'unsupported-type', detail: 'not an email file' }];
const THREAD_ANALYSIS_RESULT = analyzeThread(RESULTS);
const TIMEOUT: ThreadAnalysisOutcome = { ok: false, error: 'engine-timeout', detail: THREAD_ANALYSIS_TIMEOUT_DETAIL };
const FAILED: ThreadAnalysisOutcome = { ok: false, error: 'engine-failed', detail: THREAD_ANALYSIS_FAILED_DETAIL };
const CANCELLED: ThreadAnalysisOutcome = { ok: false, error: 'engine-failed', detail: THREAD_ANALYSIS_CANCELLED_DETAIL };

/** A fake worker: records what the page sends, lets the test play the worker's part. */
function fakeWorker(options: { createThrows?: boolean; sendThrows?: boolean; terminateThrows?: boolean } = {})
{
    let events: WorkerEvents | undefined;
    const sent: { message: ToThreadAnalysisWorker; transfer: Transferable[] }[] = [];
    const terminate = vi.fn(() =>
    {
        if (options.terminateThrows === true)
        {
            throw new Error('terminate failed');
        }
    });
    const factory: ThreadAnalysisWorkerFactory = (workerEvents) =>
    {
        if (options.createThrows === true)
        {
            throw new Error('SecurityError');
        }
        events = workerEvents;
        return {
            send: (message, transfer) =>
            {
                if (options.sendThrows === true)
                {
                    throw new Error('DataCloneError');
                }
                sent.push({ message, transfer });
            },
            terminate,
        };
    };
    const worker = (): WorkerEvents =>
    {
        if (events === undefined)
        {
            throw new Error('worker not started');
        }
        return events;
    };
    return { factory, sent, terminate, worker };
}

beforeEach(() =>
{
    vi.useFakeTimers();
});
afterEach(() =>
{
    vi.useRealTimers();
});

describe('runThreadAnalysisInWorker', () =>
{
    it("sends the parse results, resolves with the engine's result and terminates the worker", async () =>
    {
        const fake = fakeWorker();
        const pending = runThreadAnalysisInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
        expect(fake.sent).toEqual([{ message: { type: 'run', results: RESULTS }, transfer: [] }]);
        fake.worker().message({ type: 'result', result: THREAD_ANALYSIS_RESULT });
        await expect(pending).resolves.toEqual({ ok: true, result: THREAD_ANALYSIS_RESULT });
        expect(fake.terminate).toHaveBeenCalledTimes(1);
    });

    it('a worker that never answers is terminated at the time limit -> engine-timeout', async () =>
    {
        const fake = fakeWorker();
        const pending = runThreadAnalysisInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
        vi.advanceTimersByTime(TIMEOUT_MS - 1);
        expect(fake.terminate).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        await expect(pending).resolves.toEqual(TIMEOUT);
        expect(fake.terminate).toHaveBeenCalledTimes(1);
    });

    it('a result arriving after the time limit is ignored', async () =>
    {
        const fake = fakeWorker();
        const pending = runThreadAnalysisInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
        vi.advanceTimersByTime(TIMEOUT_MS);
        fake.worker().message({ type: 'result', result: THREAD_ANALYSIS_RESULT });
        await expect(pending).resolves.toEqual(TIMEOUT);
        expect(fake.terminate).toHaveBeenCalledTimes(1);
    });

    it('anything after the result is ignored, and the timer is cleared', async () =>
    {
        const fake = fakeWorker();
        const pending = runThreadAnalysisInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
        fake.worker().message({ type: 'result', result: THREAD_ANALYSIS_RESULT });
        fake.worker().message({ type: 'failed' });
        fake.worker().failure();
        vi.advanceTimersByTime(TIMEOUT_MS * 10);
        await expect(pending).resolves.toEqual({ ok: true, result: THREAD_ANALYSIS_RESULT });
        expect(fake.terminate).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        ['a failed message', (w: WorkerEvents) => w.message({ type: 'failed' })],
        ['a malformed message', (w: WorkerEvents) => w.message({ type: 'result', result: { messages: 'x' } })],
        ['a stray message', (w: WorkerEvents) => w.message('hello')],
        ['an error or messageerror event', (w: WorkerEvents) => w.failure()],
    ])('%s -> engine-failed, worker terminated', async (_label, act) =>
    {
        const fake = fakeWorker();
        const pending = runThreadAnalysisInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
        act(fake.worker());
        await expect(pending).resolves.toEqual(FAILED);
        expect(fake.terminate).toHaveBeenCalledTimes(1);
    });

    it('a worker that cannot be started -> engine-failed, never a throw', async () =>
    {
        const fake = fakeWorker({ createThrows: true });
        await expect(runThreadAnalysisInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS })).resolves.toEqual(FAILED);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a request that cannot be sent -> engine-failed, and the worker is terminated', async () =>
    {
        const fake = fakeWorker({ sendThrows: true });
        await expect(runThreadAnalysisInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS })).resolves.toEqual(FAILED);
        expect(fake.terminate).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a terminate() that throws still gives the outcome', async () =>
    {
        const fake = fakeWorker({ terminateThrows: true });
        const pending = runThreadAnalysisInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
        fake.worker().message({ type: 'result', result: THREAD_ANALYSIS_RESULT });
        await expect(pending).resolves.toEqual({ ok: true, result: THREAD_ANALYSIS_RESULT });
    });

    it('cancelled ("Clear everything"): the worker is terminated at once; a late result is ignored', async () =>
    {
        const fake = fakeWorker();
        const controller = new AbortController();
        const pending = runThreadAnalysisInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS, signal: controller.signal });
        controller.abort();
        expect(fake.terminate).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        fake.worker().message({ type: 'result', result: THREAD_ANALYSIS_RESULT });
        fake.worker().failure();
        await expect(pending).resolves.toEqual(CANCELLED);
        expect(fake.terminate).toHaveBeenCalledTimes(1);
    });

    it('already cancelled: no worker is started', async () =>
    {
        const factory = vi.fn(fakeWorker().factory);
        const controller = new AbortController();
        controller.abort();
        await expect(runThreadAnalysisInWorker(RESULTS, { createWorker: factory, timeoutMs: TIMEOUT_MS, signal: controller.signal })).resolves.toEqual(CANCELLED);
        expect(factory).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('an abort after the result changes nothing and leaves no listener behind', async () =>
    {
        const fake = fakeWorker();
        const controller = new AbortController();
        const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
        const pending = runThreadAnalysisInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS, signal: controller.signal });
        fake.worker().message({ type: 'result', result: THREAD_ANALYSIS_RESULT });
        expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
        controller.abort();
        await expect(pending).resolves.toEqual({ ok: true, result: THREAD_ANALYSIS_RESULT });
        expect(fake.terminate).toHaveBeenCalledTimes(1);
    });

    it('the time limit and details are as documented', () =>
    {
        expect(THREAD_ANALYSIS_TIMEOUT_MS).toBe(60_000);
        expect(THREAD_ANALYSIS_TIMEOUT_DETAIL).toBe('organizing the messages took too long and was stopped');
        expect(THREAD_ANALYSIS_FAILED_DETAIL).toBe('the messages could not be organized (internal error)');
    });
});
