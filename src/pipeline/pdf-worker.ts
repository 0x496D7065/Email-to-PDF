// Entry point of the PDF Web Worker (started by pdf-runner.ts, one worker
// per PDF). It only wires the worker's global scope to createPdfWorkerSide
// (pdf-protocol.ts), where the logic lives.
//
// Why a worker: laying out and writing the PDF is pure but heavy (about a
// second for 2000 emails on a fast computer, much more on a slow one or
// with long emails). On the page, that would freeze the tab. In a worker the
// page stays responsive and can stop the work at a time limit or when the
// user changes something (README.md, rule R4).
//
// Like the parse and engine workers, it has no network access paths: no
// network API, no script loading, no remote URL. Vite bundles this file and
// everything it imports into one piece of code, inlined as a string in the
// page's own script (`?worker&inline`, see pdf-runner.ts), and started from
// a `blob:` URL (allowed by `worker-src 'self' blob:`). A blob: worker takes
// the CSP of the page that started it, so `connect-src 'none'` applies here
// too. It does NOT import the font chunk: the page hands it the font bytes
// (see pdf-protocol.ts), and the build check fails if font bytes ever end up
// in the worker's code (scripts/font-rules.mjs).

import { createPdfWorkerSide, type FromPdfWorker } from './pdf-protocol';

/**
 * The part of a dedicated worker's global scope used here (described by
 * hand: the project's TypeScript setup has the page's types, not the
 * worker's; same approach as src/pipeline/engine-worker.ts).
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: FromPdfWorker, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const handle = createPdfWorkerSide((message, transfer) => scope.postMessage(message, transfer));
scope.onmessage = (event) => {
  void handle(event.data);
};
