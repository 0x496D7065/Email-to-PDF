// Entry point of the parse Web Worker (started by worker-runner.ts, one
// worker per file). It only wires the worker's global scope to
// createWorkerSide (worker-protocol.ts), where the logic lives.
//
// Why a worker: a damaged or hostile file can make a parser loop forever,
// which try/catch cannot stop. Inside a worker that only blocks the worker,
// and the page can terminate it (README.md, rule R4). Memory is only partly
// covered: typed-array allocations and array-length overflows become
// catchable errors, but a real heap exhaustion can still take down the tab,
// which is why the .msg structure check (cfb-check.ts) runs first.
//
// The worker has no network access paths: no network API, no script
// loading, no remote URL. Vite bundles this file and everything it imports
// into one separate same-origin script file (allowed by `worker-src 'self'`).
// A worker takes its CSP from the HTTP header sent with its own script, not
// from the page's <meta> tag; the site sends the CSP header with every file
// (dist/_headers), so `connect-src 'none'` applies here too. Once the page
// uses this worker, the build check scans the bundled worker file in dist/
// like any other built file.

import { createWorkerSide, type FromWorker } from './worker-protocol';

/**
 * The part of a dedicated worker's global scope used here. The project's
 * TypeScript setup has the page's types (DOM), not the worker's, so the
 * global is described by hand instead of mixing both type libraries.
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: FromWorker): void;
}

const scope = self as unknown as WorkerScope;
const handle = createWorkerSide((message) => scope.postMessage(message));
scope.onmessage = (event) => handle(event.data);
