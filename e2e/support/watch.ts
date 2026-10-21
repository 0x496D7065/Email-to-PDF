// Detectors for browser tests that run the real pipeline in the BUILT site:
// every request (pages AND their workers), WebSockets, the workers
// themselves (with their names), and the CSP reports of each worker.
//
// The parse and engine workers are inlined in the page's script and start
// from `blob:` URLs (see src/parsing/worker-runner.ts). Chromium lists the
// loading of a blob: worker script as a request to that blob: URL; it never
// goes to the network. Every blob: URL looks alike, so workers are told
// apart by the name they are started with ('parse-worker', 'engine-worker',
// 'pdf-worker'), which CDP reports as the worker target's title.
//
// These are the same detectors as in e2e/parse-files.spec.ts, which also
// holds their positive controls (proof that they really see a request or a
// CSP violation made inside a parse or engine worker):
// - context-level request tracking includes requests made by workers;
// - the page-level `securitypolicyviolation` listener does NOT see a
//   worker's violations, so a CDP session attaches to every worker before
//   its script runs and enables the `Log` domain, where Chromium reports each
//   CSP violation of that worker.
// The safety net aborts any request that leaves the preview server.
import type { BrowserContext, Page, Worker } from '@playwright/test';

export interface Watch {
  /** URL of every request of the context, in order. */
  readonly requests: string[];
  readonly websockets: string[];
  /** Every worker the page started, and those that ended. */
  readonly workers: Worker[];
  readonly closedWorkers: Worker[];
  /** Worker log entries, as "source level | text". */
  readonly workerLog: string[];
  /** Worker URL -> the name it was started with (CDP target title). */
  readonly workerNames: Map<string, string>;
}

/** Starts watching. Call before the page is opened. `origin` is the preview server's origin. */
export async function watchPage(context: BrowserContext, page: Page, origin: string): Promise<Watch> {
  const watch: Watch = { requests: [], websockets: [], workers: [], closedWorkers: [], workerLog: [], workerNames: new Map() };

  context.on('request', (request) => watch.requests.push(request.url()));
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'),
  );
  await context.routeWebSocket(/.*/, async (ws) => {
    watch.websockets.push(ws.url());
    await ws.close();
  });

  page.on('worker', (worker) => {
    watch.workers.push(worker);
    worker.on('close', () => watch.closedWorkers.push(worker));
  });
  // Auto-attach to each new worker paused before its script runs
  // (waitForDebuggerOnStart), enable its Log domain, then let it run, so no
  // entry can be missed. `flatten: false` routes the worker's messages
  // through this one session (Target.sendMessageToTarget).
  const cdp = await context.newCDPSession(page);
  let nextId = 0;
  cdp.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    const send = (method: string): void => {
      void cdp
        .send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: ++nextId, method, params: {} }) })
        .catch(() => undefined); // the worker may already be gone
    };
    if (targetInfo.type === 'worker') {
      // Recorded before the worker is let run, so before it can do anything.
      watch.workerNames.set(targetInfo.url, targetInfo.title);
      send('Log.enable');
    }
    send('Runtime.runIfWaitingForDebugger');
  });
  cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
    const parsed = JSON.parse(message) as { method?: string; params?: { entry?: { source: string; level: string; text: string } } };
    const entry = parsed.params?.entry;
    if (parsed.method === 'Log.entryAdded' && entry !== undefined) watch.workerLog.push(`${entry.source} ${entry.level} | ${entry.text}`);
  });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });

  return watch;
}

/** The workers in `list` that were started with this name. */
export function workersNamed(watch: Watch, list: readonly Worker[], name: 'parse-worker' | 'engine-worker' | 'pdf-worker'): Worker[] {
  return list.filter((worker) => watch.workerNames.get(worker.url()) === name);
}

/** Worker log entries that report a CSP violation. */
export function workerCspReports(watch: Watch): string[] {
  return watch.workerLog.filter((line) => /Content Security Policy|Refused to/i.test(line));
}
