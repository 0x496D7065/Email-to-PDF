// Unit test: parseFiles hands its cancel signal ("Clear everything") to the
// worker runner. It lives in its own file because it mocks ./parse-worker-runner:
// every other test uses the real module. Synthetic data only (README.md,
// rule R7).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFiles, PARSE_TIMEOUT_MS } from './parse-files';
import { runInWorker } from './parse-worker-runner';

// runInWorker is replaced by a spy (no worker in Node); everything else in
// the module stays real.
vi.mock('./parse-worker-runner', async (importOriginal) =>
{
    const original = await importOriginal<typeof import('./parse-worker-runner')>();
    return {
        ...original,
        runInWorker: vi.fn((job: { name: string; sha256: string }) =>
            Promise.resolve({ ok: false, fileName: job.name, sha256: job.sha256, error: 'corrupt', detail: 'fake runner' }),
        ),
    };
});

/** A small synthetic .eml. */
function emlFile(): { name: string; bytes: Uint8Array }
{
    const text = 'X-Synthetic-Fixture: true\r\nFrom: Alice Example <alice@example.test>\r\nSubject: Signal test\r\n\r\nHello.\r\n';
    return { name: 'signal.eml', bytes: new TextEncoder().encode(text) };
}

describe('parseFiles: cancel signal', () =>
{
    beforeEach(() =>
    {
        vi.mocked(runInWorker).mockClear();
    });

    it('passes the same signal object to runInWorker', async () =>
    {
        const controller = new AbortController();
        await parseFiles([emlFile()], controller.signal);
        expect(runInWorker).toHaveBeenCalledTimes(1);
        const options = vi.mocked(runInWorker).mock.calls[0]?.[1];
        expect(options?.signal).toBe(controller.signal);
        expect(options?.timeoutMs).toBe(PARSE_TIMEOUT_MS);
    });

    it('passes no signal when none is given', async () =>
    {
        await parseFiles([emlFile()]);
        expect(runInWorker).toHaveBeenCalledTimes(1);
        const options = vi.mocked(runInWorker).mock.calls[0]?.[1];
        expect(options !== undefined && 'signal' in options).toBe(false);
    });
});
