// Unit test: processFiles (the browser steps) hands its cancel signal
// ("Clear everything") to the parse step and to the thread-analysis worker runner. It
// lives in its own file because it mocks ../email-reading/parse-files and
// ./thread-analysis-worker-runner: every other test uses the real modules. Synthetic data
// only (README.md, rule R7).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { parseFiles } from '../email-reading/parse-files';
import { THREAD_ANALYSIS_TIMEOUT_MS, runThreadAnalysisInWorker } from './thread-analysis-worker-runner';
import { processFiles } from './process-files';
import type { FileLike } from '../../Header/file-processing';

// The two workers are replaced by spies (no worker in Node); everything
// else in the modules stays real.
vi.mock('../email-reading/parse-files', async (importOriginal) =>
{
    const original = await importOriginal<typeof import('../email-reading/parse-files')>();
    return {
        ...original,
        parseFiles: vi.fn((files: readonly { name: string }[]) =>
            Promise.resolve(files.map((file) => ({ ok: false, fileName: file.name, sha256: null, error: 'corrupt', detail: 'fake parse' }))),
        ),
    };
});
vi.mock('./thread-analysis-worker-runner', async (importOriginal) =>
{
    const original = await importOriginal<typeof import('./thread-analysis-worker-runner')>();
    return { ...original, runThreadAnalysisInWorker: vi.fn(() => Promise.resolve({ ok: true, result: analyzeThread([]) })) };
});

/** A fake File holding a small synthetic .eml. */
function emlFile(): FileLike
{
    const bytes = new TextEncoder().encode('X-Synthetic-Fixture: true\r\nFrom: Alice Example <alice@example.test>\r\nSubject: Signal test\r\n\r\nHello.\r\n');
    return { name: 'signal.eml', size: bytes.length, arrayBuffer: () => Promise.resolve(bytes.slice().buffer) };
}

describe('processFiles: cancel signal', () =>
{
    beforeEach(() =>
    {
        vi.mocked(parseFiles).mockClear();
        vi.mocked(runThreadAnalysisInWorker).mockClear();
    });

    it('passes the same signal object to parseFiles and runThreadAnalysisInWorker', async () =>
    {
        const controller = new AbortController();
        await processFiles([emlFile()], { signal: controller.signal });
        expect(parseFiles).toHaveBeenCalledTimes(1);
        expect(vi.mocked(parseFiles).mock.calls[0]?.[1]).toBe(controller.signal);
        expect(runThreadAnalysisInWorker).toHaveBeenCalledTimes(1);
        const options = vi.mocked(runThreadAnalysisInWorker).mock.calls[0]?.[1];
        expect(options?.signal).toBe(controller.signal);
        expect(options?.timeoutMs).toBe(THREAD_ANALYSIS_TIMEOUT_MS);
    });

    it('passes no signal to the thread-analysis runner when none is given', async () =>
    {
        await processFiles([emlFile()]);
        expect(runThreadAnalysisInWorker).toHaveBeenCalledTimes(1);
        const options = vi.mocked(runThreadAnalysisInWorker).mock.calls[0]?.[1];
        expect(options !== undefined && 'signal' in options).toBe(false);
    });
});
