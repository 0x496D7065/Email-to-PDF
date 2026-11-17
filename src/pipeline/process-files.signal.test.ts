// Unit test: processFiles (the browser steps) hands its cancel signal
// ("Clear everything") to the parse step and to the engine worker runner. It
// lives in its own file because it mocks ../parsing/parse-files and
// ./engine-runner: every other test uses the real modules. Synthetic data
// only (README.md, rule R7).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runEngine } from '../engine/engine';
import { parseFiles } from '../parsing/parse-files';
import { ENGINE_TIMEOUT_MS, runEngineInWorker } from './engine-runner';
import { processFiles } from './process-files';
import type { FileLike } from './read-files';

// The two workers are replaced by spies (no worker in Node); everything
// else in the modules stays real.
vi.mock('../parsing/parse-files', async (importOriginal) =>
{
    const original = await importOriginal<typeof import('../parsing/parse-files')>();
    return {
        ...original,
        parseFiles: vi.fn((files: readonly { name: string }[]) =>
            Promise.resolve(files.map((file) => ({ ok: false, fileName: file.name, sha256: null, error: 'corrupt', detail: 'fake parse' }))),
        ),
    };
});
vi.mock('./engine-runner', async (importOriginal) =>
{
    const original = await importOriginal<typeof import('./engine-runner')>();
    return { ...original, runEngineInWorker: vi.fn(() => Promise.resolve({ ok: true, result: runEngine([]) })) };
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
        vi.mocked(runEngineInWorker).mockClear();
    });

    it('passes the same signal object to parseFiles and runEngineInWorker', async () =>
    {
        const controller = new AbortController();
        await processFiles([emlFile()], { signal: controller.signal });
        expect(parseFiles).toHaveBeenCalledTimes(1);
        expect(vi.mocked(parseFiles).mock.calls[0]?.[1]).toBe(controller.signal);
        expect(runEngineInWorker).toHaveBeenCalledTimes(1);
        const options = vi.mocked(runEngineInWorker).mock.calls[0]?.[1];
        expect(options?.signal).toBe(controller.signal);
        expect(options?.timeoutMs).toBe(ENGINE_TIMEOUT_MS);
    });

    it('passes no signal to the engine runner when none is given', async () =>
    {
        await processFiles([emlFile()]);
        expect(runEngineInWorker).toHaveBeenCalledTimes(1);
        const options = vi.mocked(runEngineInWorker).mock.calls[0]?.[1];
        expect(options !== undefined && 'signal' in options).toBe(false);
    });
});
