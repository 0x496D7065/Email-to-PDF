// Unit tests for the page's side of the engine worker (engine-runner.ts),
// with a FAKE worker: time limit, terminate on every path, error events, bad
// and late messages. The real worker is checked in Chromium by
// e2e/parse-files.spec.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runEngine } from '../engine/engine';
import type { ParseResult } from '../parsing/types';
import type { WorkerEvents } from '../parsing/worker-runner';
import type { ToEngineWorker } from './engine-protocol';
import {
  ENGINE_CANCELLED_DETAIL,
  ENGINE_FAILED_DETAIL,
  ENGINE_TIMEOUT_DETAIL,
  ENGINE_TIMEOUT_MS,
  runEngineInWorker,
  type EngineOutcome,
  type EngineWorkerFactory,
} from './engine-runner';

const TIMEOUT_MS = 1000;
const RESULTS: ParseResult[] = [{ ok: false, fileName: 'notes.txt', sha256: null, error: 'unsupported-type', detail: 'not an email file' }];
const ENGINE_RESULT = runEngine(RESULTS);
const TIMEOUT: EngineOutcome = { ok: false, error: 'engine-timeout', detail: ENGINE_TIMEOUT_DETAIL };
const FAILED: EngineOutcome = { ok: false, error: 'engine-failed', detail: ENGINE_FAILED_DETAIL };
const CANCELLED: EngineOutcome = { ok: false, error: 'engine-failed', detail: ENGINE_CANCELLED_DETAIL };

/** A fake worker: records what the page sends, lets the test play the worker's part. */
function fakeWorker(options: { createThrows?: boolean; sendThrows?: boolean; terminateThrows?: boolean } = {}) {
  let events: WorkerEvents | undefined;
  const sent: { message: ToEngineWorker; transfer: Transferable[] }[] = [];
  const terminate = vi.fn(() => {
    if (options.terminateThrows === true) throw new Error('terminate failed');
  });
  const factory: EngineWorkerFactory = (e) => {
    if (options.createThrows === true) throw new Error('SecurityError');
    events = e;
    return {
      send: (message, transfer) => {
        if (options.sendThrows === true) throw new Error('DataCloneError');
        sent.push({ message, transfer });
      },
      terminate,
    };
  };
  const worker = (): WorkerEvents => {
    if (events === undefined) throw new Error('worker not started');
    return events;
  };
  return { factory, sent, terminate, worker };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('runEngineInWorker', () => {
  it("sends the parse results, resolves with the engine's result and terminates the worker", async () => {
    const fake = fakeWorker();
    const pending = runEngineInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
    expect(fake.sent).toEqual([{ message: { type: 'run', results: RESULTS }, transfer: [] }]);
    fake.worker().message({ type: 'result', result: ENGINE_RESULT });
    await expect(pending).resolves.toEqual({ ok: true, result: ENGINE_RESULT });
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it('a worker that never answers is terminated at the time limit -> engine-timeout', async () => {
    const fake = fakeWorker();
    const pending = runEngineInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
    vi.advanceTimersByTime(TIMEOUT_MS - 1);
    expect(fake.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await expect(pending).resolves.toEqual(TIMEOUT);
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it('a result arriving after the time limit is ignored', async () => {
    const fake = fakeWorker();
    const pending = runEngineInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
    vi.advanceTimersByTime(TIMEOUT_MS);
    fake.worker().message({ type: 'result', result: ENGINE_RESULT });
    await expect(pending).resolves.toEqual(TIMEOUT);
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it('anything after the result is ignored, and the timer is cleared', async () => {
    const fake = fakeWorker();
    const pending = runEngineInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
    fake.worker().message({ type: 'result', result: ENGINE_RESULT });
    fake.worker().message({ type: 'failed' });
    fake.worker().failure();
    vi.advanceTimersByTime(TIMEOUT_MS * 10);
    await expect(pending).resolves.toEqual({ ok: true, result: ENGINE_RESULT });
    expect(fake.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['a failed message', (w: WorkerEvents) => w.message({ type: 'failed' })],
    ['a malformed message', (w: WorkerEvents) => w.message({ type: 'result', result: { messages: 'x' } })],
    ['a stray message', (w: WorkerEvents) => w.message('hello')],
    ['an error or messageerror event', (w: WorkerEvents) => w.failure()],
  ])('%s -> engine-failed, worker terminated', async (_label, act) => {
    const fake = fakeWorker();
    const pending = runEngineInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
    act(fake.worker());
    await expect(pending).resolves.toEqual(FAILED);
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it('a worker that cannot be started -> engine-failed, never a throw', async () => {
    const fake = fakeWorker({ createThrows: true });
    await expect(runEngineInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS })).resolves.toEqual(FAILED);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a request that cannot be sent -> engine-failed, and the worker is terminated', async () => {
    const fake = fakeWorker({ sendThrows: true });
    await expect(runEngineInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS })).resolves.toEqual(FAILED);
    expect(fake.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a terminate() that throws still gives the outcome', async () => {
    const fake = fakeWorker({ terminateThrows: true });
    const pending = runEngineInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
    fake.worker().message({ type: 'result', result: ENGINE_RESULT });
    await expect(pending).resolves.toEqual({ ok: true, result: ENGINE_RESULT });
  });

  it('cancelled ("Clear everything"): the worker is terminated at once; a late result is ignored', async () => {
    const fake = fakeWorker();
    const controller = new AbortController();
    const pending = runEngineInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS, signal: controller.signal });
    controller.abort();
    expect(fake.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    fake.worker().message({ type: 'result', result: ENGINE_RESULT });
    fake.worker().failure();
    await expect(pending).resolves.toEqual(CANCELLED);
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it('already cancelled: no worker is started', async () => {
    const factory = vi.fn(fakeWorker().factory);
    const controller = new AbortController();
    controller.abort();
    await expect(runEngineInWorker(RESULTS, { createWorker: factory, timeoutMs: TIMEOUT_MS, signal: controller.signal })).resolves.toEqual(CANCELLED);
    expect(factory).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an abort after the result changes nothing and leaves no listener behind', async () => {
    const fake = fakeWorker();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = runEngineInWorker(RESULTS, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS, signal: controller.signal });
    fake.worker().message({ type: 'result', result: ENGINE_RESULT });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: true, result: ENGINE_RESULT });
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it('the time limit and details are as documented', () => {
    expect(ENGINE_TIMEOUT_MS).toBe(60_000);
    expect(ENGINE_TIMEOUT_DETAIL).toBe('organizing the messages took too long and was stopped');
    expect(ENGINE_FAILED_DETAIL).toBe('the messages could not be organized (internal error)');
  });
});
