// Entry point of the engine Web Worker (started by engine-runner.ts, one
// worker per batch). It only wires the worker's global scope to
// createEngineWorkerSide (engine-protocol.ts), where the logic lives.
//
// Why a worker: the engine (Source/thread-analysis/engine.ts) is pure and normally takes
// well under a second, but de-duplication has a known worst case (thousands
// of near-identical copies of one message make it quadratic) that can take
// seconds on hostile or unusual input. On the page, that would freeze the
// tab. In a worker the page stays responsive and can stop the work at a time
// limit (README.md, rule R4). The page still wraps the call
// (engine-runner.ts, process-files.ts), so a timeout or a crash shows a
// message instead of a frozen page or an uncaught error.
//
// Like the parse worker, it has no network access paths: no network API, no
// script loading, no remote URL. Vite bundles this file and everything it
// imports into one piece of code, inlined as a string in the page's own
// script (`?worker&inline`, see engine-runner.ts), and started from a
// `blob:` URL (allowed by `worker-src 'self' blob:`). A blob: worker takes
// the CSP of the page that started it (header and <meta>), so
// `connect-src 'none'` applies here too. The build check scans this code
// inside the page's script (Helper/build-checks/check-no-network.mjs).

import { createEngineWorkerSide } from './engine-protocol';
import type { FromEngineWorker } from '../../Header/engine-worker-messages';

/**
 * The part of a dedicated worker's global scope used here (described by
 * hand: the project's TypeScript setup has the page's types, not the
 * worker's; same approach as Source/email-reading/parse-worker.ts).
 */
interface WorkerScope
{
    onmessage: ((event: MessageEvent<unknown>) => void) | null;
    postMessage(message: FromEngineWorker): void;
}

const scope = self as unknown as WorkerScope;
const handle = createEngineWorkerSide((message) => scope.postMessage(message));
scope.onmessage = (event) => handle(event.data);
