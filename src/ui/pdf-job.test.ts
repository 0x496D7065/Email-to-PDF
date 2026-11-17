// Unit tests for step 3's state machine (pdf-job.ts), without a DOM or a
// worker: a fake `run` the test resolves by hand, and fake blob: URLs.
// Checked: idle -> making -> ready / error, a stopped or replaced job's
// late outcome ignored (job ids), the signal aborted on every stop, and the
// URL revoked on every way out of 'ready'.
import { describe, expect, it } from 'vitest';
import type { MakePdfRequest } from '../pipeline/pdf-protocol';
import type { PdfOutcome } from '../pipeline/pdf-runner';
import { createPdfJob, type PdfJobOptions, type PdfJobState } from './pdf-job';

// The request's content does not matter here: the fake run never reads it.
const REQUEST = { type: 'make' } as unknown as MakePdfRequest;
const PDF = (fileName = 'correspondence-2025-06-01.pdf', pageCount = 3): PdfOutcome => ({
    ok: true,
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    fileName,
    pageCount,
});

/** Lets pending promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(overrides: Partial<PdfJobOptions> = {})
{
    const runs: { request: MakePdfRequest; signal: AbortSignal; resolve: (o: PdfOutcome) => void; reject: (e: unknown) => void }[] = [];
    const created: string[] = [];
    const revoked: string[] = [];
    const states: PdfJobState[] = [];
    let next = 0;
    const job = createPdfJob({
        run: (request, signal) =>
            new Promise<PdfOutcome>((resolve, reject) =>
            {
                runs.push({ request, signal, resolve, reject });
            }),
        createUrl: () =>
        {
            const url = `blob:fake/${String(++next)}`;
            created.push(url);
            return url;
        },
        revokeUrl: (url) => revoked.push(url),
        onChange: (state) => states.push(state),
        ...overrides,
    });
    const last = () =>
    {
        const run = runs.at(-1);
        if (run === undefined) throw new Error('no run');
        return run;
    };
    return { job, runs, created, revoked, states, last };
}

describe('createPdfJob', () =>
{
    it('starts idle', () =>
    {
        const { job, states } = setup();
        expect(job.state()).toEqual({ kind: 'idle', changed: false });
        expect(job.isMaking()).toBe(false);
        expect(states).toEqual([]);
    });

    it('goes idle -> making -> ready, with one blob: URL for the PDF', async () =>
    {
        const { job, runs, created, revoked, states, last } = setup();
        job.start(REQUEST);
        expect(job.state()).toEqual({ kind: 'making' });
        expect(job.isMaking()).toBe(true);
        expect(runs).toHaveLength(1);
        expect(last().request).toBe(REQUEST);
        last().resolve(PDF('correspondence-2025-06-01.pdf', 7));
        await settle();
        expect(job.state()).toEqual({ kind: 'ready', url: 'blob:fake/1', fileName: 'correspondence-2025-06-01.pdf', pageCount: 7 });
        expect(created).toEqual(['blob:fake/1']);
        expect(revoked).toEqual([]);
        expect(states.map((s) => s.kind)).toEqual(['making', 'ready']);
    });

    it('hands the bytes and the file name to createUrl', async () =>
    {
        const seen: [number[], string][] = [];
        const { job, last } = setup({
            createUrl: (bytes, fileName) =>
            {
                seen.push([[...bytes], fileName]);
                return 'blob:fake/x';
            },
        });
        job.start(REQUEST);
        last().resolve(PDF('correspondence-2024-12-31.pdf'));
        await settle();
        expect(seen).toEqual([[[0x25, 0x50, 0x44, 0x46], 'correspondence-2024-12-31.pdf']]);
    });

    it.each(['timeout', 'tool-error', 'not-started'] as const)('goes making -> error for "%s" (no URL made)', async (error) =>
    {
        const { job, created, last } = setup();
        job.start(REQUEST);
        last().resolve({ ok: false, error });
        await settle();
        expect(job.state()).toEqual({ kind: 'error', error });
        expect(created).toEqual([]);
    });

    it('treats a rejected or throwing run as a tool error', async () =>
    {
        const a = setup();
        a.job.start(REQUEST);
        a.last().reject(new Error('boom'));
        await settle();
        expect(a.job.state()).toEqual({ kind: 'error', error: 'tool-error' });

        const b = setup({
            run: () =>
            {
                throw new Error('sync boom');
            },
        });
        b.job.start(REQUEST);
        await settle();
        expect(b.job.state()).toEqual({ kind: 'error', error: 'tool-error' });
    });

    it('becomes an error, not a broken link, when the URL cannot be made', async () =>
    {
        const { job, last } = setup({
            createUrl: () =>
            {
                throw new Error('out of memory');
            },
        });
        job.start(REQUEST);
        last().resolve(PDF());
        await settle();
        expect(job.state()).toEqual({ kind: 'error', error: 'tool-error' });
    });

    it('ignores a "cancelled" outcome of the current job (defensive): back to idle', async () =>
    {
        const { job, last } = setup();
        job.start(REQUEST);
        last().resolve({ ok: false, error: 'cancelled' });
        await settle();
        expect(job.state()).toEqual({ kind: 'idle', changed: false });
    });

    describe('a change of choice (inputsChanged)', () =>
    {
        it('stops a running job: signal aborted, idle (changed), its late PDF ignored', async () =>
        {
            const { job, created, last, states } = setup();
            job.start(REQUEST);
            const run = last();
            job.inputsChanged();
            expect(run.signal.aborted).toBe(true);
            expect(job.state()).toEqual({ kind: 'idle', changed: true });
            run.resolve(PDF());
            await settle();
            expect(job.state()).toEqual({ kind: 'idle', changed: true });
            expect(created).toEqual([]);
            expect(states.map((s) => s.kind)).toEqual(['making', 'idle']);
        });

        it('drops a ready PDF: its URL is revoked', async () =>
        {
            const { job, revoked, last } = setup();
            job.start(REQUEST);
            last().resolve(PDF());
            await settle();
            job.inputsChanged();
            expect(revoked).toEqual(['blob:fake/1']);
            expect(job.state()).toEqual({ kind: 'idle', changed: true });
            // A second change revokes nothing more and changes nothing.
            job.inputsChanged();
            expect(revoked).toEqual(['blob:fake/1']);
            expect(job.state()).toEqual({ kind: 'idle', changed: true });
        });

        it('clears an error (nothing was dropped: not "changed")', async () =>
        {
            const { job, last } = setup();
            job.start(REQUEST);
            last().resolve({ ok: false, error: 'timeout' });
            await settle();
            job.inputsChanged();
            expect(job.state()).toEqual({ kind: 'idle', changed: false });
        });

        it('does nothing when idle', () =>
        {
            const { job, states } = setup();
            job.inputsChanged();
            expect(job.state()).toEqual({ kind: 'idle', changed: false });
            expect(states).toEqual([]);
        });
    });

    describe('"Clear everything" (reset)', () =>
    {
        it('stops a running job: signal aborted, idle, its late PDF ignored', async () =>
        {
            const { job, created, last } = setup();
            job.start(REQUEST);
            const run = last();
            job.reset();
            expect(run.signal.aborted).toBe(true);
            expect(job.state()).toEqual({ kind: 'idle', changed: false });
            run.resolve(PDF());
            await settle();
            expect(job.state()).toEqual({ kind: 'idle', changed: false });
            expect(created).toEqual([]);
        });

        it('drops a ready PDF: its URL is revoked', async () =>
        {
            const { job, revoked, last } = setup();
            job.start(REQUEST);
            last().resolve(PDF());
            await settle();
            job.reset();
            expect(revoked).toEqual(['blob:fake/1']);
            expect(job.state()).toEqual({ kind: 'idle', changed: false });
        });

        it('ignores a late failure of the stopped job', async () =>
        {
            const { job, last } = setup();
            job.start(REQUEST);
            const run = last();
            job.reset();
            run.resolve({ ok: false, error: 'tool-error' });
            await settle();
            expect(job.state()).toEqual({ kind: 'idle', changed: false });
        });
    });

    describe('a new job', () =>
    {
        it('replaces a running one: the old signal is aborted and its outcome ignored', async () =>
        {
            const { job, runs, created } = setup();
            job.start(REQUEST);
            job.start(REQUEST);
            expect(runs).toHaveLength(2);
            const [first, second] = runs;
            expect(first?.signal.aborted).toBe(true);
            expect(second?.signal.aborted).toBe(false);
            first?.resolve(PDF('old.pdf'));
            await settle();
            expect(job.state()).toEqual({ kind: 'making' });
            second?.resolve(PDF('new.pdf'));
            await settle();
            expect(job.state()).toMatchObject({ kind: 'ready', fileName: 'new.pdf' });
            expect(created).toEqual(['blob:fake/1']);
        });

        it('revokes the URL of the PDF ready before', async () =>
        {
            const { job, revoked, last } = setup();
            job.start(REQUEST);
            last().resolve(PDF());
            await settle();
            job.start(REQUEST);
            expect(revoked).toEqual(['blob:fake/1']);
            expect(job.state()).toEqual({ kind: 'making' });
            last().resolve(PDF());
            await settle();
            expect(job.state()).toMatchObject({ kind: 'ready', url: 'blob:fake/2' });
        });
    });

    it('revokes every URL it made exactly once, whatever the way out', async () =>
    {
        const { job, created, revoked, last } = setup();
        for (const leave of [() => job.inputsChanged(), () => job.reset(), () => job.start(REQUEST)])
        {
            job.start(REQUEST);
            last().resolve(PDF());
            await settle();
            leave();
        }
        job.reset();
        expect(created).toHaveLength(3);
        expect(revoked).toEqual(created);
    });

    it('keeps its bookkeeping when the listener throws', async () =>
    {
        const { job, last } = setup({
            onChange: () =>
            {
                throw new Error('listener bug');
            },
        });
        job.start(REQUEST);
        last().resolve(PDF());
        await settle();
        expect(job.state().kind).toBe('ready');
    });
});
