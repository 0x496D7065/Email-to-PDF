// TEST-ONLY entry point for e2e/parse-files.spec.ts. Never part of the site:
// index.html and src/main.ts do not import it, so `vite build` (dist/) never
// contains it. The spec bundles it in memory with the project's own Vite
// config, so the parse worker (src/parsing/parse-worker.ts) is emitted as a
// separate script file exactly as in the production build, and serves the
// bundle on the site's own origin with the site's real security headers.

import { buildMsg } from '../../tests/fixtures/msg/builder';
import { MSG_SPECS } from '../../tests/fixtures/msg/specs';
import { connectWorker, type WorkerFactory } from '../../src/parsing/worker-runner';

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

// Synthetic fixtures, inlined by Vite's `?raw` (the test runner has no file
// system types).
export { default as FIXTURE_PLAIN } from '../../tests/fixtures/eml/01-plain-english.eml?raw';
export { default as FIXTURE_HTML_ONLY } from '../../tests/fixtures/eml/50-html-only.eml?raw';
export { default as FIXTURE_NO_DATE } from '../../tests/fixtures/eml/70-no-date.eml?raw';
export { default as FIXTURE_BAD_DATE } from '../../tests/fixtures/eml/71-bad-date.eml?raw';

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
