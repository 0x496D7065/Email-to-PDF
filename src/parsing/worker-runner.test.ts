// Unit tests for the page's side of a parse worker (worker-runner.ts), with a
// FAKE worker: time limits, terminate, error events, bad messages and the HTML
// round trip run in Node without a browser. The real Worker is checked in
// Chromium by e2e/parse-files.spec.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HtmlToTextResult } from './html-to-text';
import type { ParseResult } from './types';
import type { ToWorker } from './worker-protocol';
import {
  DETACHED_DETAIL,
  isDetached,
  runInWorker,
  TIMEOUT_DETAIL,
  WORKER_FAILED_DETAIL,
  WORKER_START_DETAIL,
  type WorkerEvents,
  type WorkerFactory,
  type WorkerJob,
} from './worker-runner';

const SHA = 'a'.repeat(64);
const TIMEOUT_MS = 1000;

/** A fake worker: records what the page sends, lets the test play the worker's part. */
function fakeWorker(options: { onSend?: (message: ToWorker) => void; sendThrows?: boolean; terminateThrows?: boolean } = {}) {
  let events: WorkerEvents | undefined;
  const sent: { message: ToWorker; transfer: Transferable[] }[] = [];
  const terminate = vi.fn(() => {
    if (options.terminateThrows === true) throw new Error('terminate failed');
  });
  const factory: WorkerFactory = (e) => {
    events = e;
    return {
      send: (message, transfer) => {
        if (options.sendThrows === true) throw new Error('DataCloneError');
        sent.push({ message, transfer });
        options.onSend?.(message);
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

function job(bytes: Uint8Array = new Uint8Array([1, 2, 3])): WorkerJob {
  return { name: 'order.eml', kind: 'eml', bytes, sha256: SHA };
}

const neverConvert = (): HtmlToTextResult => {
  throw new Error('no HTML expected');
};

const FAILED_IN_WORKER: ParseResult = { ok: false, fileName: 'order.eml', sha256: SHA, error: 'corrupt', detail: 'damaged file structure: x' };

/** True once `promise` has settled (fake timers: microtasks only). */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('runInWorker: normal end', () => {
  it("sends the parse request, resolves with the worker's result and terminates the worker", async () => {
    const fake = fakeWorker();
    const pending = runInWorker(job(), { createWorker: fake.factory, htmlToText: neverConvert, timeoutMs: TIMEOUT_MS });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.message).toMatchObject({ type: 'parse', name: 'order.eml', kind: 'eml' });
    fake.worker().message({ type: 'result', result: FAILED_IN_WORKER });
    await expect(pending).resolves.toEqual(FAILED_IN_WORKER);
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it('moves (transfers) a buffer the bytes fully cover, without copying', () => {
    const fake = fakeWorker();
    const bytes = new Uint8Array([1, 2, 3]);
    void runInWorker(job(bytes), { createWorker: fake.factory, htmlToText: neverConvert, timeoutMs: TIMEOUT_MS });
    const sent = fake.sent[0];
    expect(sent?.transfer).toEqual([bytes.buffer]);
    expect(sent?.message.type === 'parse' && sent.message.bytes.buffer).toBe(bytes.buffer);
  });

  it('copies bytes that are a view into a larger buffer, so the rest of that buffer is never moved', () => {
    const fake = fakeWorker();
    const big = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const view = big.subarray(2, 5);
    void runInWorker(job(view), { createWorker: fake.factory, htmlToText: neverConvert, timeoutMs: TIMEOUT_MS });
    const sent = fake.sent[0];
    const moved = sent?.message.type === 'parse' ? sent.message.bytes : undefined;
    expect(moved && [...moved]).toEqual([1, 2, 3]);
    expect(moved?.buffer).not.toBe(big.buffer);
    expect(sent?.transfer).toEqual([moved?.buffer]);
  });

  it('ignores anything the worker sends after the result', async () => {
    const fake = fakeWorker();
    const pending = runInWorker(job(), { createWorker: fake.factory, htmlToText: neverConvert, timeoutMs: TIMEOUT_MS });
    fake.worker().message({ type: 'result', result: FAILED_IN_WORKER });
    fake.worker().message({ type: 'failed' });
    fake.worker().failure();
    vi.advanceTimersByTime(TIMEOUT_MS * 10);
    await expect(pending).resolves.toEqual(FAILED_IN_WORKER);
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('runInWorker: time limit', () => {
  it('a worker that never answers is terminated at the limit; the file gets a timeout result, not corrupt', async () => {
    const fake = fakeWorker();
    const pending = runInWorker(job(), { createWorker: fake.factory, htmlToText: neverConvert, timeoutMs: TIMEOUT_MS });
    vi.advanceTimersByTime(TIMEOUT_MS - 1);
    expect(await settled(pending)).toBe(false);
    expect(fake.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await expect(pending).resolves.toEqual({ ok: false, fileName: 'order.eml', sha256: SHA, error: 'timeout', detail: TIMEOUT_DETAIL });
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it('a result arriving after the limit is ignored', async () => {
    const fake = fakeWorker();
    const pending = runInWorker(job(), { createWorker: fake.factory, htmlToText: neverConvert, timeoutMs: TIMEOUT_MS });
    vi.advanceTimersByTime(TIMEOUT_MS);
    fake.worker().message({ type: 'result', result: FAILED_IN_WORKER });
    await expect(pending).resolves.toMatchObject({ error: 'timeout', detail: TIMEOUT_DETAIL });
  });

  it('the details are plain words', () => {
    expect(TIMEOUT_DETAIL).toBe('took too long to read (stopped)');
    expect(WORKER_START_DETAIL).toBe('the reading step could not start (worker not started)');
    expect(WORKER_FAILED_DETAIL).toBe('the reading step stopped unexpectedly (worker failed)');
  });
});

describe('runInWorker: worker failures', () => {
  const failures: [string, (events: WorkerEvents) => void][] = [
    ["an 'error' or 'messageerror' event (crash, script not loaded)", (e) => e.failure()],
    ["a 'failed' message (an error thrown in the worker)", (e) => e.message({ type: 'failed' })],
    ['a malformed message', (e) => e.message({ type: 'result' })],
    ['a message that is not an object', (e) => e.message('hello')],
    ['an unknown message type', (e) => e.message({ type: 'progress' })],
  ];

  it.each(failures)('%s -> tool-error (not corrupt), worker failed, terminated', async (_label, act) => {
    const fake = fakeWorker();
    const pending = runInWorker(job(), { createWorker: fake.factory, htmlToText: neverConvert, timeoutMs: TIMEOUT_MS });
    act(fake.worker());
    await expect(pending).resolves.toEqual({ ok: false, fileName: 'order.eml', sha256: SHA, error: 'tool-error', detail: WORKER_FAILED_DETAIL });
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it('a worker that cannot be started -> tool-error with its own detail, never a throw', async () => {
    const pending = runInWorker(job(), {
      createWorker: () => {
        throw new Error('SecurityError: worker blocked');
      },
      htmlToText: neverConvert,
      timeoutMs: TIMEOUT_MS,
    });
    await expect(pending).resolves.toEqual({ ok: false, fileName: 'order.eml', sha256: SHA, error: 'tool-error', detail: WORKER_START_DETAIL });
  });

  it('a request that cannot be sent -> tool-error, and the worker is terminated', async () => {
    const fake = fakeWorker({ sendThrows: true });
    const pending = runInWorker(job(), { createWorker: fake.factory, htmlToText: neverConvert, timeoutMs: TIMEOUT_MS });
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'tool-error', detail: WORKER_FAILED_DETAIL });
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it('bytes already moved away (detached buffer) -> a clear non-damage detail, no worker started', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] }); // moves it away, as a first worker would
    expect(isDetached(bytes)).toBe(true);
    const createWorker = vi.fn<WorkerFactory>();
    const pending = runInWorker(job(bytes), { createWorker, htmlToText: neverConvert, timeoutMs: TIMEOUT_MS });
    await expect(pending).resolves.toEqual({ ok: false, fileName: 'order.eml', sha256: SHA, error: 'tool-error', detail: DETACHED_DETAIL });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('isDetached: false for normal bytes, an empty array, and a view into a larger buffer', () => {
    expect(isDetached(new Uint8Array([1]))).toBe(false);
    expect(isDetached(new Uint8Array(0))).toBe(false);
    expect(isDetached(new Uint8Array(8).subarray(2, 4))).toBe(false);
  });

  it('the same bytes given twice: the first is moved to its worker, the second reports it clearly', async () => {
    const fake = fakeWorker();
    const bytes = new Uint8Array([1, 2, 3]);
    const first = runInWorker(job(bytes), { createWorker: fake.factory, htmlToText: neverConvert, timeoutMs: TIMEOUT_MS });
    // Play the browser's part: postMessage with a transfer list moves the buffer.
    const sent = fake.sent[0];
    if (sent === undefined) throw new Error('nothing sent');
    structuredClone(sent.message, { transfer: sent.transfer });
    fake.worker().message({ type: 'result', result: FAILED_IN_WORKER });
    await first;
    await expect(runInWorker(job(bytes), { createWorker: fake.factory, htmlToText: neverConvert, timeoutMs: TIMEOUT_MS })).resolves.toMatchObject({
      detail: DETACHED_DETAIL,
    });
  });

  it('a terminate() that throws still gives the result', async () => {
    const fake = fakeWorker({ terminateThrows: true });
    const pending = runInWorker(job(), { createWorker: fake.factory, htmlToText: neverConvert, timeoutMs: TIMEOUT_MS });
    fake.worker().message({ type: 'result', result: FAILED_IN_WORKER });
    await expect(pending).resolves.toEqual(FAILED_IN_WORKER);
  });
});

describe('runInWorker: HTML converted on the page', () => {
  it('converts the HTML the worker asks for, in order, and sends the outcomes back', () => {
    const fake = fakeWorker();
    const converter = vi.fn((html: string): HtmlToTextResult => ({ text: html.toUpperCase(), truncated: html === 'b' }));
    void runInWorker(job(), { createWorker: fake.factory, htmlToText: converter, timeoutMs: TIMEOUT_MS });
    fake.worker().message({ type: 'html', htmls: ['a', 'b'] });
    expect(converter.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    expect(fake.sent[1]).toEqual({
      message: {
        type: 'conversions',
        outcomes: [
          { ok: true, text: 'A', truncated: false },
          { ok: true, text: 'B', truncated: true },
        ],
      },
      transfer: [],
    });
  });

  it('a converter that throws is sent back as a converter failure, not a worker failure', async () => {
    const fake = fakeWorker();
    const pending = runInWorker(job(), {
      createWorker: fake.factory,
      htmlToText: () => {
        throw new RangeError('Maximum call stack size exceeded');
      },
      timeoutMs: TIMEOUT_MS,
    });
    fake.worker().message({ type: 'html', htmls: ['<div>'] });
    expect(fake.sent[1]?.message).toEqual({ type: 'conversions', outcomes: [{ ok: false, reason: 'Maximum call stack size exceeded' }] });
    expect(await settled(pending)).toBe(false);
    expect(fake.terminate).not.toHaveBeenCalled();
  });

  it('time spent converting on the page does not count; the clock restarts for the second parse', async () => {
    const fake = fakeWorker();
    const slowConverter = (): HtmlToTextResult => {
      vi.advanceTimersByTime(TIMEOUT_MS * 5); // the page is busy converting
      return { text: 't', truncated: false };
    };
    const pending = runInWorker(job(), { createWorker: fake.factory, htmlToText: slowConverter, timeoutMs: TIMEOUT_MS });
    vi.advanceTimersByTime(TIMEOUT_MS - 1);
    fake.worker().message({ type: 'html', htmls: ['<p>x</p>'] });
    expect(await settled(pending)).toBe(false);
    // A fresh limit for the second parse: still running just before it ends...
    vi.advanceTimersByTime(TIMEOUT_MS - 1);
    expect(await settled(pending)).toBe(false);
    // ...and stopped when it ends.
    vi.advanceTimersByTime(1);
    await expect(pending).resolves.toMatchObject({ detail: TIMEOUT_DETAIL });
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it('conversions that cannot be sent -> tool-error, worker failed', async () => {
    let calls = 0;
    const fake = fakeWorker({
      onSend: () => {
        if (++calls === 2) throw new Error('DataCloneError');
      },
    });
    const pending = runInWorker(job(), { createWorker: fake.factory, htmlToText: () => ({ text: 't', truncated: false }), timeoutMs: TIMEOUT_MS });
    fake.worker().message({ type: 'html', htmls: ['<p>x</p>'] });
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'tool-error', detail: WORKER_FAILED_DETAIL });
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });
});
