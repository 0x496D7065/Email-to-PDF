// TEST-ONLY entry point for e2e/parse-files.spec.ts. Never part of the site:
// index.html and src/main.ts do not import it, so `vite build` (dist/) never
// contains it. The spec bundles it in memory with the project's own Vite
// config, so the parse worker (src/parsing/parse-worker.ts) and the engine
// worker (src/pipeline/engine-worker.ts) are emitted as separate script
// files exactly as in the production build, and serves the bundle on the
// site's own origin with the site's real security headers.

import { buildMsg } from '../../tests/fixtures/msg/builder';
import { MSG_SPECS } from '../../tests/fixtures/msg/specs';
import { connectWorker, type WorkerFactory } from '../../src/parsing/worker-runner';
import type { ToEngineWorker } from '../../src/pipeline/engine-protocol';
import type { EngineWorkerFactory } from '../../src/pipeline/engine-runner';

export {
  MAX_FILE_BYTES,
  PARSE_TIMEOUT_MS,
  FILE_TOO_LARGE_DETAIL,
  parseFiles,
  parseFilesWith,
} from '../../src/parsing/parse-files';
export { htmlToTextWithDomParser } from '../../src/parsing/html-dom';
export { createBrowserWorker, runInWorker, TIMEOUT_DETAIL, WORKER_FAILED_DETAIL } from '../../src/parsing/worker-runner';
export type { InputFile, ParseResult } from '../../src/parsing/types';
export { processFiles, processFilesWith, type ProcessProgress, type ProcessResult } from '../../src/pipeline/process-files';
export {
  createBrowserEngineWorker,
  ENGINE_FAILED_DETAIL,
  ENGINE_TIMEOUT_DETAIL,
  ENGINE_TIMEOUT_MS,
  runEngineInWorker,
} from '../../src/pipeline/engine-runner';

// Synthetic fixtures, inlined by Vite's `?raw` (the test runner has no file
// system types).
export { default as FIXTURE_PLAIN } from '../../tests/fixtures/eml/01-plain-english.eml?raw';
export { default as FIXTURE_HTML_ONLY } from '../../tests/fixtures/eml/50-html-only.eml?raw';
export { default as FIXTURE_NO_DATE } from '../../tests/fixtures/eml/70-no-date.eml?raw';
export { default as FIXTURE_BAD_DATE } from '../../tests/fixtures/eml/71-bad-date.eml?raw';
// A short order thread (10 -> 11 -> 12) and an exact copy of 11, for processFiles.
export { default as FIXTURE_ORDER_1 } from '../../tests/fixtures/eml/10-order-1-alice.eml?raw';
export { default as FIXTURE_ORDER_2 } from '../../tests/fixtures/eml/11-order-2-bob-outlook-en.eml?raw';
export { default as FIXTURE_ORDER_3 } from '../../tests/fixtures/eml/12-order-3-alice-gmail.eml?raw';
export { default as FIXTURE_ORDER_2_COPY } from '../../tests/fixtures/eml/30-dup-order-2-copy.eml?raw';

/** A well-formed synthetic .msg (the first spec of the fixture set). */
export function goodMsg(): Uint8Array {
  const spec = MSG_SPECS[0];
  if (spec === undefined) throw new Error('no .msg spec');
  return buildMsg(spec);
}

/**
 * A synthetic .msg whose directory sector chain points back to itself: the
 * kind of file that makes msgreader loop forever. The Compound File check
 * (cfb-check.ts) must reject it before msgreader reads it.
 */
export function loopingMsg(): Uint8Array {
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
export function createMisbehavingEngineWorker(mode: 'hang' | 'crash'): EngineWorkerFactory {
  return (events) => {
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
