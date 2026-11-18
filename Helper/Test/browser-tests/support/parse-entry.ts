// TEST-ONLY entry point for Helper/Test/browser-tests/parse-files.spec.ts. Never part of the site:
// Source/index.html and Source/main.ts do not import it, so `vite build` (dist/) never
// contains it. The spec bundles it in memory with the project's own Vite
// config, so the parse worker (Source/email-reading/parse-worker.ts), the engine
// worker (Source/worker-pipeline/engine-worker.ts) and the PDF worker
// (Source/worker-pipeline/pdf-worker.ts) are inlined and started from blob:
// URLs exactly as in the production build, and serves the bundle on the
// site's own origin with the site's real security headers.

import { buildMsg } from '../../test-data/msg/builder';
import { MSG_SPECS } from '../../test-data/msg/specs';
import { connectWorker, type WorkerFactory } from '../../../../Source/email-reading/parse-worker-runner';
import type { EngineWorkerFactory } from '../../../../Source/worker-pipeline/engine-runner';
import type { ToEngineWorker } from '../../../../Header/engine-worker-messages';

export {
    MAX_FILE_BYTES,
    PARSE_TIMEOUT_MS,
    FILE_TOO_LARGE_DETAIL,
    parseFiles,
    parseFilesWith,
} from '../../../../Source/email-reading/parse-files';
export { htmlToTextWithDomParser } from '../../../../Source/email-reading/browser-html-to-text';
export { createBrowserWorker, runInWorker, TIMEOUT_DETAIL, WORKER_FAILED_DETAIL } from '../../../../Source/email-reading/parse-worker-runner';
export { processFiles, processFilesWith } from '../../../../Source/worker-pipeline/process-files';
export {
    createBrowserEngineWorker,
    ENGINE_FAILED_DETAIL,
    ENGINE_TIMEOUT_DETAIL,
    ENGINE_TIMEOUT_MS,
    runEngineInWorker,
} from '../../../../Source/worker-pipeline/engine-runner';
// Only to start an idle PDF worker for the CSP checks (Source/worker-pipeline/pdf-worker.ts).
export { createBrowserPdfWorker } from '../../../../Source/worker-pipeline/pdf-runner';

// Synthetic fixtures, inlined by Vite's `?raw` (the test runner has no file
// system types).
export { default as FIXTURE_PLAIN } from '../../test-data/eml/01-plain-english.eml?raw';
export { default as FIXTURE_HTML_ONLY } from '../../test-data/eml/50-html-only.eml?raw';
export { default as FIXTURE_NO_DATE } from '../../test-data/eml/70-no-date.eml?raw';
export { default as FIXTURE_BAD_DATE } from '../../test-data/eml/71-bad-date.eml?raw';
// A short order thread (10 -> 11 -> 12) and an exact copy of 11, for processFiles.
export { default as FIXTURE_ORDER_1 } from '../../test-data/eml/10-order-1-alice.eml?raw';
export { default as FIXTURE_ORDER_2 } from '../../test-data/eml/11-order-2-bob-outlook-en.eml?raw';
export { default as FIXTURE_ORDER_3 } from '../../test-data/eml/12-order-3-alice-gmail.eml?raw';
export { default as FIXTURE_ORDER_2_COPY } from '../../test-data/eml/30-dup-order-2-copy.eml?raw';

/** A well-formed synthetic .msg (the first spec of the fixture set). */
export function goodMsg(): Uint8Array
{
    const spec = MSG_SPECS[0];
    if (spec === undefined)
    {
        throw new Error('no .msg spec');
    }
    return buildMsg(spec);
}

/**
 * A synthetic .msg whose directory sector chain points back to itself: the
 * kind of file that makes msgreader loop forever. The Compound File check
 * (compound-file-check.ts) must reject it before msgreader reads it.
 */
export function loopingMsg(): Uint8Array
{
    const bytes = goodMsg();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sectorSize = 512; // the builder writes version 3 files
    const firstDirectorySector = view.getUint32(0x30, true);
    const firstFatSector = view.getUint32(0x4c, true);
    view.setUint32((firstFatSector + 1) * sectorSize + 4 * firstDirectorySector, firstDirectorySector, true);
    return bytes;
}

/** A worker that hangs or crashes (misbehaving-worker.ts), wired like the real one. */
export const createMisbehavingWorker: WorkerFactory = (events) =>
    connectWorker(new Worker(new URL('./misbehaving-worker.ts', import.meta.url), { type: 'module' }), events);

/**
 * The misbehaving test worker standing in for the engine worker. The engine
 * request carries no file name, so `mode` is sent as the name the
 * misbehaving worker reads: 'hang' spins forever, anything else crashes.
 */
export function createMisbehavingEngineWorker(mode: 'hang' | 'crash'): EngineWorkerFactory
{
    return (events) =>
    {
        const handle = connectWorker<{ readonly name: string }>(
            new Worker(new URL('./misbehaving-worker.ts', import.meta.url), { type: 'module' }),
            events,
        );
        return {
            send: (_message: ToEngineWorker, transfer) => handle.send({ name: mode }, transfer),
            terminate: () => handle.terminate(),
        };
    };
}
