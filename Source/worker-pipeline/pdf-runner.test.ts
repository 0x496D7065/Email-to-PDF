// Unit tests for the page's side of the PDF worker (pdf-runner.ts), with a
// FAKE worker: time limit, terminate on every path, error events, bad and
// late messages, cancel. The real worker is checked in Chromium by
// e2e/download.spec.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEvents } from '../email-reading/worker-runner';
import type { MakePdfRequest, ToPdfWorker } from './pdf-protocol';
import { PDF_TIMEOUT_BASE_MS, PDF_TIMEOUT_PER_EMAIL_MS, pdfTimeoutMs, runPdfInWorker, type PdfOutcome, type PdfWorkerFactory } from './pdf-runner';

const TIMEOUT_MS = 1000;
// The request's content does not matter to the runner: it only passes it on.
const REQUEST = { type: 'make', input: { positions: [] }, fonts: {} } as unknown as MakePdfRequest;
const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const DONE = { type: 'done', bytes: BYTES, fileName: 'correspondence-2025-06-01.pdf', pageCount: 4 };

/** A fake worker: records what the page sends, lets the test play the worker's part. */
function fakeWorker(options: { createThrows?: boolean; sendThrows?: boolean; terminateThrows?: boolean } = {})
{
    let events: WorkerEvents | undefined;
    const sent: { message: ToPdfWorker; transfer: Transferable[] }[] = [];
    const terminate = vi.fn(() =>
    {
        if (options.terminateThrows === true)
        {
            throw new Error('terminate failed');
        }
    });
    const factory: PdfWorkerFactory = (e) =>
    {
        if (options.createThrows === true)
        {
            throw new Error('SecurityError');
        }
        events = e;
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

describe('pdfTimeoutMs', () =>
{
    it('is 2 minutes plus 50 ms per email', () =>
    {
        expect(PDF_TIMEOUT_BASE_MS).toBe(120_000);
        expect(PDF_TIMEOUT_PER_EMAIL_MS).toBe(50);
        expect(pdfTimeoutMs(0)).toBe(120_000);
        expect(pdfTimeoutMs(1)).toBe(120_050);
        expect(pdfTimeoutMs(2000)).toBe(220_000);
        expect(pdfTimeoutMs(-5)).toBe(120_000);
    });
});

describe('runPdfInWorker', () =>
{
    it('sends the request (copied, nothing moved), returns the PDF and terminates the worker', async () =>
    {
        const fake = fakeWorker();
        const outcome = runPdfInWorker(REQUEST, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
        expect(fake.sent).toEqual([{ message: REQUEST, transfer: [] }]);
        expect(fake.sent[0]?.message).toBe(REQUEST);
        fake.worker().message(DONE);
        await expect(outcome).resolves.toEqual({ ok: true, bytes: BYTES, fileName: DONE.fileName, pageCount: 4 });
        expect(fake.terminate).toHaveBeenCalledTimes(1);
    });

    it('stops the worker at the time limit: "timeout", and ignores a late PDF', async () =>
    {
        const fake = fakeWorker();
        const outcome = runPdfInWorker(REQUEST, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
        vi.advanceTimersByTime(TIMEOUT_MS - 1);
        expect(fake.terminate).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        await expect(outcome).resolves.toEqual({ ok: false, error: 'timeout' });
        expect(fake.terminate).toHaveBeenCalledTimes(1);
        fake.worker().message(DONE);
        expect(fake.terminate).toHaveBeenCalledTimes(1);
    });

    it('clears the time limit once the PDF is there', async () =>
    {
        const fake = fakeWorker();
        const outcome = runPdfInWorker(REQUEST, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
        fake.worker().message(DONE);
        await expect(outcome).resolves.toMatchObject({ ok: true });
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        ['a "failed" message', (w: WorkerEvents) => w.message({ type: 'failed' })],
        ['an error event', (w: WorkerEvents) => w.failure()],
        ['a malformed message', (w: WorkerEvents) => w.message({ type: 'done', bytes: 'not bytes', fileName: 'x.pdf', pageCount: 1 })],
        ['an unknown message', (w: WorkerEvents) => w.message({ type: 'progress' })],
        ['null', (w: WorkerEvents) => w.message(null)],
    ])('turns %s into "tool-error" and terminates the worker', async (_label, act) =>
    {
        const fake = fakeWorker();
        const outcome = runPdfInWorker(REQUEST, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
        act(fake.worker());
        await expect(outcome).resolves.toEqual({ ok: false, error: 'tool-error' });
        expect(fake.terminate).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('says "not-started" when the worker cannot be created (and starts no clock)', async () =>
    {
        const fake = fakeWorker({ createThrows: true });
        const outcome = runPdfInWorker(REQUEST, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
        await expect(outcome).resolves.toEqual({ ok: false, error: 'not-started' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('says "tool-error" when the request cannot be sent, and terminates the worker', async () =>
    {
        const fake = fakeWorker({ sendThrows: true });
        const outcome = runPdfInWorker(REQUEST, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
        await expect(outcome).resolves.toEqual({ ok: false, error: 'tool-error' });
        expect(fake.terminate).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('still settles when terminate throws', async () =>
    {
        const fake = fakeWorker({ terminateThrows: true });
        const outcome = runPdfInWorker(REQUEST, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
        fake.worker().message(DONE);
        await expect(outcome).resolves.toMatchObject({ ok: true });
    });

    it('uses only the first answer', async () =>
    {
        const fake = fakeWorker();
        const outcome = runPdfInWorker(REQUEST, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS });
        fake.worker().message({ type: 'failed' });
        fake.worker().message(DONE);
        fake.worker().failure();
        await expect(outcome).resolves.toEqual({ ok: false, error: 'tool-error' });
        expect(fake.terminate).toHaveBeenCalledTimes(1);
    });

    describe('cancel (signal)', () =>
    {
        it('terminates the worker at once: "cancelled", a late PDF ignored', async () =>
        {
            const fake = fakeWorker();
            const controller = new AbortController();
            const outcome = runPdfInWorker(REQUEST, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS, signal: controller.signal });
            controller.abort();
            expect(fake.terminate).toHaveBeenCalledTimes(1);
            await expect(outcome).resolves.toEqual({ ok: false, error: 'cancelled' });
            expect(vi.getTimerCount()).toBe(0);
            fake.worker().message(DONE);
            expect(fake.terminate).toHaveBeenCalledTimes(1);
        });

        it('starts no worker when already aborted', async () =>
        {
            const fake = fakeWorker();
            const controller = new AbortController();
            controller.abort();
            const outcome = runPdfInWorker(REQUEST, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS, signal: controller.signal });
            await expect(outcome).resolves.toEqual({ ok: false, error: 'cancelled' });
            expect(fake.sent).toEqual([]);
            expect(() => fake.worker()).toThrow('worker not started');
        });

        it('does nothing after the outcome', async () =>
        {
            const fake = fakeWorker();
            const controller = new AbortController();
            const outcome = runPdfInWorker(REQUEST, { createWorker: fake.factory, timeoutMs: TIMEOUT_MS, signal: controller.signal });
            fake.worker().message(DONE);
            const result: PdfOutcome = await outcome;
            controller.abort();
            expect(result.ok).toBe(true);
            expect(fake.terminate).toHaveBeenCalledTimes(1);
        });
    });
});
