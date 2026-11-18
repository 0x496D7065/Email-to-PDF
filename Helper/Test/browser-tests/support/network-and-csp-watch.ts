// Detectors for browser tests that run the real pipeline in the BUILT site:
// every request (pages AND their workers), WebSockets, the workers
// themselves (with their names), and the CSP reports of each worker.
//
// The parse and thread-analysis workers are inlined in the page's script and start
// from `blob:` URLs (see Source/email-reading/parse-worker-runner.ts). Chromium lists the
// loading of a blob: worker script as a request to that blob: URL; it never
// goes to the network (Firefox and WebKit do not list it). Every blob: URL
// looks alike, so workers are told apart by the name they are started with
// ('parse-worker', 'engine-worker' for the thread-analysis worker, 'pdf-worker').
//
// These are the same detectors as in Helper/Test/browser-tests/parse-files.spec.ts, which also
// holds their positive controls (proof that they really see a request or a
// CSP violation made inside a parse, thread-analysis or PDF worker), in every browser:
// - context-level request tracking includes requests made by workers;
// - the page-level `securitypolicyviolation` listener does NOT see a
//   worker's violations. So a test-only init script (watchWorkers) starts
//   each blob: worker from a copy of its script with a few lines put in
//   FRONT: a `securitypolicyviolation` listener that passes every report of
//   that worker to the test through a BroadcastChannel (in-page messaging, no
//   request). It runs before the worker's own code, so no report can be
//   missed. The same init script records the name each worker is started
//   with. The worker's own code is unchanged, and a blob: worker takes the
//   page's CSP whatever its blob, so it runs under the same policy. A worker
//   started by the page without that prelude, or one Playwright lists that
//   did not go through the page's Worker, makes workerCspReports fail. The
//   prelude also wraps the worker's own Worker (where it has one) and reports
//   every worker started from inside it (WebKit does not list those to
//   Playwright, and they have no prelude); any such start also makes
//   workerCspReports fail, as the app never nests workers. So the relay fails
//   closed for every worker start a script can make through Worker.
// - In Chromium only, as before, a CDP session also attaches to every worker
//   before its script runs and enables the `Log` domain, where Chromium
//   reports each CSP violation of that worker. CDP exists only in Chromium.
// The safety net aborts any request that leaves the preview server.
import { expect, type BrowserContext, type Page, type Request, type Worker } from '@playwright/test';

/** What watchWorkers records about the workers of a page. */
export interface WorkerWatch
{
    /** Every worker the page started, and those that ended. */
    readonly workers: Worker[];
    readonly closedWorkers: Worker[];
    /** Worker CSP reports, as "securitypolicyviolation directive blockedURI | worker name" (every browser) or, from CDP in Chromium only, "source level | text". */
    readonly workerLog: string[];
    /** Worker URL -> the name it was started with. */
    readonly workerNames: Map<string, string>;
    /**
     * URL of each worker started WITHOUT the prelude (not from a JavaScript
     * Blob): its CSP reports reach no detector outside Chromium, so
     * workerCspReports fails while there is any (fail closed).
     */
    readonly unwrappedWorkers: string[];
}

export interface PageWatch extends WorkerWatch
{
    /** URL of every request of the context, in order (WebKit's in-memory blob reads left out, see isWebKitBlobRead). */
    readonly requests: string[];
    readonly websockets: string[];
}

/**
 * WebKit only: WebKit reads a Blob or File through an internal `blob:` URL
 * of the page's own origin (Blob.stream(), new Response(blob), also the
 * loading of a blob: worker script), and Playwright lists each read as an
 * 'xhr' GET request to that URL. A blob: URL is resolved in memory and
 * never reaches the network. Exactly that shape is set apart: a GET, of type
 * 'xhr', to `blob:<site origin>/<uuid>`. Any other request still counts.
 */
export function isWebKitBlobRead(request: Request, origin: string): boolean
{
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const url = request.url();
    return (
        request.method() === 'GET' &&
        request.resourceType() === 'xhr' &&
        url.startsWith(`blob:${origin}/`) &&
        uuid.test(url.slice(`blob:${origin}/`.length))
    );
}

/** The name of the browser engine of `context` ('chromium', 'firefox' or 'webkit'). */
export const browserEngineOf = (context: BrowserContext): string => context.browser()?.browserType().name() ?? '';

/** BroadcastChannel name between the worker prelude and the page (test-only). */
const REPORT_CHANNEL = '__e2e-worker-csp';

/**
 * The lines put in front of each blob: worker's script (a classic script, as
 * Vite inlines it). Passes every CSP violation of the worker to the page.
 */
const WORKER_PRELUDE = `(() => {
  const channel = new BroadcastChannel(${JSON.stringify(REPORT_CHANNEL)});
  self.addEventListener('securitypolicyviolation', (event) => {
    channel.postMessage('securitypolicyviolation ' + event.effectiveDirective + ' ' + event.blockedURI + ' | ' + self.name);
  });
  // A worker started from inside this one has no prelude (and WebKit does not
  // even list it to Playwright): report every such start, before it is made.
  if (typeof self.Worker === 'function') {
    self.Worker = new Proxy(self.Worker, {
      construct(target, args, newTarget) {
        channel.postMessage('nested-worker ' + String(args[0]) + ' | ' + self.name);
        return Reflect.construct(target, args, newTarget);
      },
    });
  }
})();
`;

declare global
{
    interface Window
    {
        __e2eWorkerStarted: (url: string, name: string, wrapped: boolean) => Promise<void>;
        __e2eWorkerReport: (line: string) => Promise<void>;
    }
}

/** Follows every worker of `page` into `sink`. Call before the page is opened. */
export async function watchWorkers(context: BrowserContext, page: Page, sink: WorkerWatch): Promise<void>
{
    page.on('worker', (worker) =>
    {
        sink.workers.push(worker);
        worker.on('close', () => sink.closedWorkers.push(worker));
    });
    await page.exposeFunction('__e2eWorkerStarted', (url: string, name: string, wrapped: boolean) =>
    {
        sink.workerNames.set(url, name);
        if (!wrapped)
        {
            sink.unwrappedWorkers.push(url);
        }
    });
    await page.exposeFunction('__e2eWorkerReport', (line: string) =>
    {
        sink.workerLog.push(line);
    });
    await page.addInitScript(
        ({ channelName, prelude }) =>
        {
            // The worker scripts the page turns into blob: URLs (Vite's inline
            // workers); other blobs (the PDF) are left alone. A worker started any
            // other way runs without the prelude and is reported as not wrapped.
            const scripts = new Map<string, Blob>();
            const createObjectURL = URL.createObjectURL.bind(URL);
            URL.createObjectURL = (object: Blob | MediaSource): string =>
            {
                const url = createObjectURL(object);
                if (object instanceof Blob && /javascript/.test(object.type))
                {
                    scripts.set(url, object);
                }
                return url;
            };
            window.Worker = new Proxy(window.Worker, {
                construct(target, args: ConstructorParameters<typeof Worker>, newTarget)
                {
                    const [url, options] = args;
                    const script = scripts.get(String(url));
                    const start = script ? createObjectURL(new Blob([prelude, script], { type: script.type })) : url;
                    const worker = Reflect.construct(target, [start, options], newTarget) as Worker;
                    // Async binding: the test sees this start a moment later, so it checks after the work is done.
                    void window.__e2eWorkerStarted(String(start), options?.name ?? '', script !== undefined);
                    return worker;
                },
            });
            const channel = new BroadcastChannel(channelName);
            channel.onmessage = (event: MessageEvent<unknown>) =>
            {
                void window.__e2eWorkerReport(String(event.data));
            };
        },
        { channelName: REPORT_CHANNEL, prelude: WORKER_PRELUDE },
    );

    if (browserEngineOf(context) !== 'chromium')
    {
        return;
    }
    // Chromium only: auto-attach to each new worker paused before its script
    // runs (waitForDebuggerOnStart), enable its Log domain, then let it run, so
    // no entry can be missed. `flatten: false` routes the worker's messages
    // through this one session (Target.sendMessageToTarget).
    const cdp = await context.newCDPSession(page);
    let nextId = 0;
    cdp.on('Target.attachedToTarget', ({ sessionId, targetInfo }) =>
    {
        const send = (method: string): void =>
        {
            void cdp
                .send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: ++nextId, method, params: {} }) })
                .catch(() => undefined); // the worker may already be gone
        };
        if (targetInfo.type === 'worker')
        {
            send('Log.enable');
        }
        send('Runtime.runIfWaitingForDebugger');
    });
    cdp.on('Target.receivedMessageFromTarget', ({ message }) =>
    {
        const parsed = JSON.parse(message) as { method?: string; params?: { entry?: { source: string; level: string; text: string } } };
        const entry = parsed.params?.entry;
        if (parsed.method === 'Log.entryAdded' && entry !== undefined)
        {
            sink.workerLog.push(`${entry.source} ${entry.level} | ${entry.text}`);
        }
    });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
}

/** Starts watching. Call before the page is opened. `origin` is the preview server's origin. */
export async function watchPage(context: BrowserContext, page: Page, origin: string): Promise<PageWatch>
{
    const watch: PageWatch = { requests: [], websockets: [], workers: [], closedWorkers: [], workerLog: [], workerNames: new Map(),
        unwrappedWorkers: [] };

    const webkit = browserEngineOf(context) === 'webkit';
    context.on('request', (request) =>
    {
        if (!(webkit && isWebKitBlobRead(request, origin)))
        {
            watch.requests.push(request.url());
        }
    });
    await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'),
    );
    await context.routeWebSocket(/.*/, async (ws) =>
    {
        watch.websockets.push(ws.url());
        await ws.close();
    });
    await watchWorkers(context, page, watch);
    return watch;
}

/** The workers in `list` that were started with this name. */
export function workersNamed(watch: WorkerWatch, list: readonly Worker[], name: 'parse-worker' | 'engine-worker' | 'pdf-worker'): Worker[]
{
    return list.filter((worker) => watch.workerNames.get(worker.url()) === name);
}

/**
 * Worker log entries that report a CSP violation (both detectors). Fails
 * closed first: every worker the page started must have gone through the
 * page's Worker (a recorded name) with the prelude in front, or its reports
 * could be missed outside Chromium; and no worker may start another one
 * (reported by the prelude as "nested-worker <url> | <name>"). `exempt`:
 * exact URLs of test-only workers allowed to run without it
 * (Helper/Test/browser-tests/parse-files.spec.ts only). Starts and reports reach the test through
 * async bindings, so call this after the work is done.
 */
export function workerCspReports(watch: WorkerWatch, exempt: ReadonlySet<string> = new Set()): string[]
{
    const label = (url: string): string => `${url} | ${watch.workerNames.get(url) ?? '(no name)'}`;
    expect(watch.unwrappedWorkers.filter((url) => !exempt.has(url)).map(label), 'workers started without the CSP report relay').toEqual([]);
    expect(watch.workerLog.filter((line) => line.startsWith('nested-worker ')), 'workers started from inside a worker').toEqual([]);
    const unseen = watch.workers.map((worker) => worker.url()).filter((url) => !watch.workerNames.has(url));
    expect(unseen, 'workers not started through the watched Worker constructor').toEqual([]);
    return watch.workerLog.filter((line) => /^securitypolicyviolation |Content Security Policy|Refused to/i.test(line));
}

// DOMParser's parse-time CSP reports. A spec that shows email HTML records
// each `securitypolicyviolation` event of the page as
// "directive blockedURI parse|live" ("parse" when fired at the document).

/**
 * Directives of the CSP reports Chromium makes while DOMParser PARSES inline
 * handlers and styles (nothing runs). No fixture has a <base> element, so
 * 'base-uri' is not among them (see parseTimeReportFilter).
 */
const PARSE_TIME_DIRECTIVES: ReadonlySet<string> = new Set(['script-src-attr', 'style-src-elem', 'style-src-attr']);

/**
 * True for a recorded report ("directive blockedURI parse|live") made while
 * DOMParser parses: blockedURI "inline", fired at the document itself (the
 * parsed element is in no live page). The same directive fired at an element
 * is an inline handler or style in the LIVE page, and is never tolerated.
 */
export const isParseTimeReport = (record: string): boolean =>
    PARSE_TIME_DIRECTIVES.has(record.split(' ')[0] ?? '') && record.endsWith(' inline parse');

/**
 * One more parse-time report a spec tolerates, as an exact record, never as
 * a whole directive: only base-uri or media-src, only for a URL of the
 * reserved `.invalid` domain, only labelled "parse" (Helper/Test/browser-tests/html-to-text.spec.ts:
 * the <base> and <track> elements of its hostile HTML).
 */
export type ExactParseTimeReport = `${'base-uri' | 'media-src'} https://${string}.invalid/${string} parse`;

/**
 * The recorded reports that are NOT tolerated. Only Chromium makes those
 * parse-time reports: Firefox and WebKit make none for the same DOMParser
 * input (seen with the hostile HTML of Helper/Test/browser-tests/html-to-text.spec.ts). So they are
 * tolerated in Chromium only; in another browser every report counts.
 */
export function untoleratedReports(browserName: string, records: readonly string[], isTolerated: (record: string) => boolean = isParseTimeReport): string[]
{
    return records.filter((record) => browserName !== 'chromium' || !isTolerated(record));
}

/** isParseTimeReport, plus exactly the records in `exact` (compared whole). */
export function parseTimeReportFilter(exact: ReadonlySet<ExactParseTimeReport>): (record: string) => boolean
{
    const records: ReadonlySet<string> = exact;
    return (record) => isParseTimeReport(record) || records.has(record);
}

/**
 * The console lines Chromium writes for those same parse-time reports, with
 * the directives they go with. Each tolerated line needs a report of its
 * own: there may never be more such lines than matching reports. Any other
 * console error fails the test.
 */
export const PARSE_TIME_CONSOLE: readonly { readonly line: RegExp; readonly directives: readonly string[] }[] = [
    {
        line: /^console: Executing inline event handler violates the following Content Security Policy directive 'script-src 'self''\./,
        directives: ['script-src-attr'],
    },
    {
        line: /^console: Applying inline style violates the following Content Security Policy directive 'style-src 'self''\./,
        directives: ['style-src-elem', 'style-src-attr'],
    },
];

// WebKit and <select>. WebKit builds every <select> element with an inner
// part of its own (not the page's), styled inline, and checks that style
// against the page's CSP: each <select> made in a page with this CSP gives
// one style-src-attr report per policy (header, <meta>), fired at the
// <select>, and one console error for each. Seen for a <select> in the HTML
// and one made by script alike; Chromium and Firefox report nothing. The
// page has exactly one <select> (the time zone of the preview), so a spec's
// recorder labels a report fired at a <select> "select" and these helpers
// take out exactly that many, after checking the count: one per policy in
// WebKit, none elsewhere. Any other report or console error still fails.

/** A recorded report ("directive blockedURI label") of that <select> quirk. */
export const SELECT_REPORT = 'style-src-attr inline select';

/** WebKit's console line for each of those reports (as a spec records it, "console: ..."). */
export const WEBKIT_SELECT_CONSOLE =
    "console: Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";

/**
 * `records` without the <select> reports, after checking there are exactly
 * `policies` of them in WebKit (2: header and <meta>) and none in another
 * browser. For a page loaded once since the recorder started.
 */
export function withoutSelectReports(browserName: string, records: readonly string[], policies = 2): string[]
{
    expect(records.filter((r) => r === SELECT_REPORT), 'WebKit <select> reports').toHaveLength(browserName === 'webkit' ? policies : 0);
    return records.filter((r) => r !== SELECT_REPORT);
}

/** Same for the console lines (`problems`), with `loads` page loads recorded. */
export function withoutSelectConsole(browserName: string, problems: readonly string[], policies = 2, loads = 1): string[]
{
    expect(problems.filter((p) => p === WEBKIT_SELECT_CONSOLE), 'WebKit <select> console lines').toHaveLength(browserName === 'webkit' ? policies * loads : 0);
    return problems.filter((p) => p !== WEBKIT_SELECT_CONSOLE);
}
