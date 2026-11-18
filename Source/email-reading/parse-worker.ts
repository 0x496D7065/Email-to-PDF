// Entry point of the parse Web Worker (started by parse-worker-runner.ts, one
// worker per file). It only wires the worker's global scope to
// createWorkerSide (parse-worker-protocol.ts), where the logic lives.
//
// Why a worker: a damaged or hostile file can make a parser loop forever,
// which try/catch cannot stop. Inside a worker that only blocks the worker,
// and the page can terminate it (README.md, rule R4). Memory is only partly
// covered: typed-array allocations and array-length overflows become
// catchable errors, but a real heap exhaustion can still take down the tab,
// which is why the .msg structure check (compound-file-check.ts) runs first.
//
// The worker has no network access paths: no network API, no script
// loading, no remote URL. Vite bundles this file and everything it imports
// into one piece of code, inlined as a string in the page's own script
// (`?worker&inline`, see parse-worker-runner.ts), and started from a `blob:` URL
// (allowed by `worker-src 'self' blob:`), so it also starts offline. A blob:
// worker takes the CSP of the page that started it (the HTTP header and the
// <meta> tag), so `connect-src 'none'` applies here too. The build check
// scans this code inside the page's script, after undoing the string
// escapes (Helper/build-checks/check-no-network.mjs).

import { createWorkerSide } from './parse-worker-protocol';
import type { FromWorker } from '../../Header/parse-worker-messages';

/**
 * The part of a dedicated worker's global scope used here. The project's
 * TypeScript setup has the page's types (DOM), not the worker's, so the
 * global is described by hand instead of mixing both type libraries.
 */
interface WorkerScope
{
    onmessage: ((event: MessageEvent<unknown>) => void) | null;
    postMessage(message: FromWorker): void;
}

const scope = self as unknown as WorkerScope;
const handle = createWorkerSide((message) => scope.postMessage(message));
scope.onmessage = (event) => handle(event.data);
