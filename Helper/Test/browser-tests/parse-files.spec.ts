// Browser test of the parse pipeline (README.md, rules R1, R2 and R4): every
// dropped file is parsed in its own Web Worker with a time limit, and broken,
// huge or hostile files give a clear per-file result without ever crashing
// the batch or the page. The thread analysis then organizes the results in its own
// worker (Source/worker-pipeline/thread-analysis-worker.ts), also with a time limit; processFiles
// (Source/worker-pipeline/process-files.ts) chains it all from browser File objects.
// Runs in Chromium, Firefox and WebKit against the site served by
// `vite preview` (see playwright.config.ts).
//
// How the code gets into the page without shipping a test hook:
// beforeAll bundles Helper/Test/browser-tests/support/parse-files-test-entry.ts IN MEMORY (`write: false`)
// with the project's own vite.config.ts, the same configuration as the
// production build. As in dist/, the parse, thread-analysis and PDF workers are
// inlined into that bundle (`?worker&inline`) and start from blob: URLs. A
// small capture plugin also keeps each worker's own code, so the first test
// can prove that the build check really sees that code inside the bundle.
// A Playwright route serves the bundle at /__e2e__/... on the site's own
// origin, with the site's real security headers. A blob: worker takes the
// CSP of the PAGE that starts it (header and <meta> alike), so the positive
// controls below change the page's CSP (both, <meta> only, none). Nothing is
// written to dist/ and the CSP is unchanged. (The misbehaving test worker is
// still a separate script file: it stands in for a broken worker and is
// never part of the site.)
//
// What these tests rely on to see worker activity (the page-level
// `securitypolicyviolation` listener and `routeWebSocket` do NOT see what a
// worker does):
// - context-level request tracking, which includes requests made by workers
//   (proved by a positive control below);
// - page.on('worker') to follow every worker and its 'close' event
//   (terminated);
// - watchWorkers (Helper/Test/browser-tests/support/network-and-csp-watch.ts), in every browser: each blob: worker
//   starts with a `securitypolicyviolation` listener put in front of its
//   code, which passes every CSP report of that worker to the test; the name
//   each worker is started with tells the parse, thread-analysis and PDF workers
//   apart (their blob: URLs all look alike);
// - in Chromium also, a CDP session that attaches to every worker of the
//   page before its script runs and enables the `Log` domain, where Chromium
//   reports each CSP violation of that worker ("Refused to connect ...").
//   Playwright's worker 'console' event does not carry these reports (seen
//   in Chromium);
// - a `securitypolicyviolation` listener installed INSIDE a worker with
//   worker.evaluate, for the positive control.
// Requests are re-checked after processing has finished and a quiet period,
// not only at page load.
import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { build, type Plugin, type Rolldown } from 'vite';
import { decodeJsEscapes, findEmbeddedViolations, findViolations } from '../../build-checks/no-network-rules.mjs';
import { cspForHeader, cspForMeta, PERMISSIONS_POLICY, REFERRER_POLICY } from '../../../Source/security-headers/headers.ts';
import type * as Entry from './support/parse-files-test-entry.ts';
// The page's CSP reports are filtered with untoleratedReports: in Chromium
// only, the inline reports DOMParser makes while it PARSES handlers and
// styles, fired at the document, are tolerated. The HTML parsed here has no
// <base> element, so 'base-uri' is not among them. (A blocked load is fired
// at the document wherever it happens: never tolerated, see
// Helper/Test/browser-tests/html-to-text.spec.ts.)
import {
    browserEngineOf,
    isWebKitBlobRead,
    untoleratedReports,
    watchWorkers,
    workerCspReports as sharedWorkerCspReports,
} from './support/network-and-csp-watch.ts';
import type { ProcessProgress, ProcessResult } from '../../../Header/file-processing.ts';
import type { InputFile } from '../../../Header/parsed-email.ts';

declare global
{
    interface Window
    {
        /** "directive blockedURI parse|live" of each CSP violation in the page. */
        __e2eViolations: string[];
        /** Keeps a test worker alive for the positive controls. */
        __e2eKeep: unknown;
        /** Whether the stuck test worker's job is still running ('running') or has its result ('settled'). */
        __e2eHang: 'running' | 'settled' | undefined;
    }
}

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('../../..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const BUNDLE_PATH = '/__e2e__/';

/** The in-memory test bundle: path below BUNDLE_PATH -> file contents. */
const bundle = new Map<string, string>();
let entryUrl = '';

/** The code of each worker bundle Vite builds, by entry file name ('parse-worker', 'thread-analysis-worker', ...). */
const workerSources = new Map<string, string>();

/**
 * Keeps a copy of each worker bundle while Vite builds it (Vite runs a
 * separate build for each worker; `worker.plugins` take part in it). For an
 * inline worker, this is the exact code Vite then puts in the page's script
 * as a string.
 */
const captureWorkerCode: Plugin = {
    name: 'e2e-capture-worker-code',
    generateBundle(_options, output)
    {
        for (const item of Object.values(output))
        {
            if (item.type !== 'chunk' || !item.isEntry || item.facadeModuleId === null)
            {
                continue;
            }
            const file = item.facadeModuleId.split('?')[0]?.split('/').pop() ?? '';
            workerSources.set(file.replace(/[.]ts$/, ''), item.code);
        }
    },
};

test.beforeAll(async () =>
{
    test.setTimeout(120_000);
    const output = await build({
        root: ROOT,
        configFile: `${ROOT}vite.config.ts`,
        mode: 'production',
        logLevel: 'warn',
        base: BUNDLE_PATH,
        worker: { plugins: () => [captureWorkerCode] },
        build: {
            write: false, // in memory only: dist/ is never touched
            emptyOutDir: false,
            copyPublicDir: false,
            rolldownOptions: { input: `${ROOT}Helper/Test/browser-tests/support/parse-files-test-entry.ts`, preserveEntrySignatures: 'exports-only' },
        },
    });
    const outputs = (Array.isArray(output) ? output : [output]) as Rolldown.RolldownOutput[];
    for (const item of outputs.flatMap((o) => o.output))
    {
        const code = item.type === 'chunk' ? item.code : typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source);
        bundle.set(item.fileName, code);
        if (item.type === 'chunk' && item.isEntry)
        {
            entryUrl = `${BUNDLE_PATH}${item.fileName}`;
        }
    }
    expect(entryUrl).not.toBe('');
    expect(workerSources.get('parse-worker')?.length ?? 0).toBeGreaterThan(1000);
    expect(workerSources.get('thread-analysis-worker')?.length ?? 0).toBeGreaterThan(1000);
    expect(workerSources.get('pdf-worker')?.length ?? 0).toBeGreaterThan(1000);
});

let origin = '';
let requestUrls: string[] = [];
/** requestUrls.length once the page had loaded. */
let loadedAt = 0;
let websockets: string[] = [];
let workers: Worker[] = [];
let closedWorkers: Worker[] = [];
/** CSP reports of every worker (see WorkerWatch in Helper/Test/browser-tests/support/network-and-csp-watch.ts). */
let workerLog: string[] = [];
/** Worker URL -> the name it was started with; blob: URLs all look alike. */
let workerNames = new Map<string, string>();
/** URL of each worker started without the CSP report prelude (see WorkerWatch). */
let unwrappedWorkers: string[] = [];

/**
 * Records every request of the context (pages and their workers), except
 * WebKit's in-memory blob reads (isWebKitBlobRead); aborts anything that
 * leaves the preview server.
 */
async function watchNetwork(context: BrowserContext): Promise<void>
{
    const webkit = browserEngineOf(context) === 'webkit';
    context.on('request', (request) =>
    {
        if (!(webkit && isWebKitBlobRead(request, origin)))
        {
            requestUrls.push(request.url());
        }
    });
    await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'),
    );
    await context.routeWebSocket(/.*/, async (ws) =>
    {
        websockets.push(ws.url());
        await ws.close();
    });
}

/** The headers every file of the site is sent with (dist/_headers, `vite preview`). */
const SITE_HEADERS = {
    'Content-Security-Policy': cspForHeader(),
    'Referrer-Policy': REFERRER_POLICY,
    'Permissions-Policy': PERMISSIONS_POLICY,
};

/** Serves the in-memory test bundle on the site's own origin, with the site's security headers. */
async function serveBundle(page: Page): Promise<void>
{
    await page.route(`**${BUNDLE_PATH}**`, async (route) =>
    {
        const name = new URL(route.request().url()).pathname.slice(BUNDLE_PATH.length);
        const code = bundle.get(name);
        if (code === undefined)
        {
            await route.fulfill({ status: 404, headers: SITE_HEADERS });
            return;
        }
        await route.fulfill({ body: code, contentType: 'text/javascript', headers: SITE_HEADERS });
    });
}

/**
 * Which CSP the PAGE gets (positive controls only): 'meta' drops the CSP
 * header from the page's response, as on a host that cannot send headers;
 * 'none' also removes the <meta> CSP tag. The blob: workers the page starts
 * take whatever the page has.
 */
type PageCsp = 'header and meta' | 'meta' | 'none';

async function servePageWith(page: Page, csp: PageCsp): Promise<void>
{
    if (csp === 'header and meta')
    {
        return;
    }
    await page.route(
        (url) => url.origin === origin && url.pathname === '/',
        async (route) =>
        {
            const response = await route.fetch();
            const headers = { ...response.headers() };
            delete headers['content-security-policy'];
            let body = await response.text();
            if (csp === 'none')
            {
                const tag = /<meta http-equiv="Content-Security-Policy"[^>]*>/;
                expect(body).toMatch(tag);
                body = body.replace(tag, '');
            }
            await route.fulfill({ response, headers, body });
        },
    );
}

/**
 * Worker log entries that report a CSP violation (see Helper/Test/browser-tests/support/network-and-csp-watch.ts).
 * Every worker must run with the report prelude, except the test's own
 * misbehaving worker (exact URL of that file in the test bundle): it is
 * started from its script file, served with the site's headers, and only
 * hangs or crashes.
 */
const workerCspReports = (): string[] =>
{
    const misbehaving = [...bundle.keys()].filter((name) => /misbehaving-worker/.test(name));
    expect(misbehaving).toHaveLength(1);
    const exempt = new Set(misbehaving.map((name) => `${origin}${BUNDLE_PATH}${name}`));
    return sharedWorkerCspReports({ workers, closedWorkers, workerLog, workerNames, unwrappedWorkers }, exempt);
};

test.beforeEach(async ({ context, page, baseURL }) =>
{
    origin = new URL(baseURL ?? '').origin;
    requestUrls = [];
    loadedAt = 0;
    websockets = [];
    workers = [];
    closedWorkers = [];
    workerLog = [];
    workerNames = new Map();
    unwrappedWorkers = [];
    await watchNetwork(context);
    // Follows every worker the page starts: its end (page.on('worker')), its
    // name and its CSP reports (see Helper/Test/browser-tests/support/network-and-csp-watch.ts).
    await watchWorkers(context, page, { workers, closedWorkers, workerLog, workerNames, unwrappedWorkers });
    await page.addInitScript(() =>
    {
        window.__e2eViolations = [];
        // An inline report made while DOMParser parses is fired at the document;
        // an inline one about the live page at the element concerned.
        document.addEventListener('securitypolicyviolation', (event) =>
        {
            const where = event.target === document ? 'parse' : 'live';
            window.__e2eViolations.push(`${event.effectiveDirective} ${event.blockedURI} ${where}`);
        });
    });
});

async function open(page: Page): Promise<void>
{
    await page.goto('/', { waitUntil: 'networkidle' });
    loadedAt = requestUrls.length;
}

/**
 * Requests since the page loaded, except the test bundle's own files and the
 * blob: URLs the workers start from (Chromium lists loading a blob: worker
 * script as a request; it is read from memory, never from the network).
 */
function requestsAfterLoad(): string[]
{
    const workerUrls = new Set(workers.map((w) => w.url()));
    return requestUrls
        .slice(loadedAt)
        .filter((url) => !workerUrls.has(url))
        .filter((url) => !(new URL(url).origin === origin && new URL(url).pathname.startsWith(BUNDLE_PATH)));
}

/** The parse workers (not the test's misbehaving worker) seen so far. */
const parseWorkers = (list: readonly Worker[]): Worker[] => list.filter((w) => workerNames.get(w.url()) === 'parse-worker');
/** The thread-analysis workers seen so far (runtime name 'engine-worker'). */
const threadAnalysisWorkers = (list: readonly Worker[]): Worker[] => list.filter((w) => workerNames.get(w.url()) === 'engine-worker');

/**
 * After processing has finished: waits a quiet period, then asserts that
 * nothing (page or worker) made a request, opened a WebSocket or triggered a
 * CSP violation, and that the page is still alive.
 */
async function expectNoNetworkAndPageAlive(page: Page): Promise<void>
{
    await page.waitForTimeout(1000);
    expect(requestsAfterLoad()).toEqual([]);
    expect(websockets).toEqual([]);
    // In the page, only the parse-time reports DOMParser makes for inline
    // handlers and <style> blocks in email HTML are expected: nothing runs or
    // loads (see Helper/Test/browser-tests/html-to-text.spec.ts, which proves it with and without the
    // CSP). Anything else, including the same directive fired at a live
    // element, would be an attempted load or execution.
    const pageViolations = await page.evaluate(() => window.__e2eViolations);
    expect(untoleratedReports(browserEngineOf(page.context()), pageViolations)).toEqual([]);
    expect(workerCspReports()).toEqual([]);
    expect(await page.title()).toBe('Email to PDF');
    expect(await page.evaluate(() => 6 * 7)).toBe(42);
}

/** What the tests compare of each result (plain data, no message text beyond what is checked). */
interface Summary
{
    readonly fileName: string;
    readonly ok: boolean;
    readonly error?: string;
    readonly detail?: string;
    readonly kind?: string;
    readonly warnings?: readonly string[];
    readonly utcMs?: number | null;
    readonly bodyLooksConverted?: boolean;
    readonly hashed: boolean;
}

test('the parse, thread-analysis and PDF workers are inlined in the page script, and the build check sees their code', () =>
{
    // As in dist/: no separate parse, thread-analysis or PDF worker file. A worker file is
    // fetched each time a worker starts, which fails once the network is off.
    expect([...bundle.keys()].filter((file) => /(parse|thread-analysis|pdf)-worker/.test(file))).toEqual([]);
    const allCode = [...bundle.entries()]
        .filter(([file]) => file.endsWith('.js'))
        .map(([, code]) => code)
        .join('BUNDLE-FILE-SEPARATOR');
    const decoded = decodeJsEscapes(allCode);
    for (const name of ['parse-worker', 'thread-analysis-worker', 'pdf-worker'])
    {
        const workerCode = workerSources.get(name) ?? '';
        // The worker's own code passes the same scan as every dist/ file.
        expect(findViolations(workerCode, { isDist: true, distFile: `${name}.js` }), name).toEqual([]);
        // One self-contained script: no module imports, no script loading, no
        // eval (each would need more than the CSP allows, or a request).
        expect(workerCode, name).not.toMatch(/\bimport\s*[({"'*]|\bimportScripts\b|(?<![\w$.])eval\s*\(|\bnew Function\b/);
        // It sits in the bundle as a string. Once its escapes are undone (what
        // Helper/build-checks/check-no-network.mjs does for every dist/ file), it reads
        // exactly as the worker's code: the build check scans what the worker runs.
        expect(decoded.includes(workerCode), name).toBe(true);
    }
    // The whole bundle is not scanned here: this TEST bundle also holds the
    // synthetic fixture emails, whose tracker URLs are there on purpose. The
    // real dist/ is scanned, raw and decoded, by the build check. The decoded
    // scan still flags network code hidden in the worker string:
    // (the worker's code plus one line, stored as a string the way Vite inlines it)
    const planted = JSON.stringify([workerSources.get('thread-analysis-worker') ?? '', 'XMLHttpRequest;'].join(String.fromCharCode(10)));
    expect(findViolations(planted, { isDist: true }).map((f) => f.match)).not.toContain('XMLHttpRequest');
    expect(findEmbeddedViolations(planted, { isDist: true }).map((f) => f.match)).toContain('XMLHttpRequest');
    // The only worker still started from a script file is the test's own
    // misbehaving worker; the real ones start from blob: URLs.
    const fileWorkers = [...allCode.matchAll(/new Worker[(]new URL[(]`([^`]+)`/g)].map((m) => m[1]);
    expect(fileWorkers.length).toBeGreaterThan(0);
    for (const url of fileWorkers)
    {
        expect(url).toMatch(/misbehaving-worker/);
    }
});

test('a batch with broken, huge and unsupported files: one result per file, in order, and the page survives', async ({ page }) =>
{
    test.setTimeout(60_000);
    await serveBundle(page);
    await open(page);

    const summaries = await page.evaluate(async (url) =>
    {
        const entry = (await import(url)) as typeof Entry;
        const text = (s: string): Uint8Array => new TextEncoder().encode(s);
        const files: InputFile[] = [
            { name: 'plain.eml', bytes: text(entry.FIXTURE_PLAIN) },
            { name: 'good.msg', bytes: entry.goodMsg() },
            { name: 'looping.msg', bytes: entry.loopingMsg() },
            { name: 'notes.txt', bytes: text('Order notes, not an email.') },
            { name: 'empty.eml', bytes: new Uint8Array(0) },
            { name: 'huge.eml', bytes: new Uint8Array(entry.MAX_FILE_BYTES + 1) },
            { name: 'html-only.eml', bytes: text(entry.FIXTURE_HTML_ONLY) },
            { name: 'no-date.eml', bytes: text(entry.FIXTURE_NO_DATE) },
            { name: 'bad-date.eml', bytes: text(entry.FIXTURE_BAD_DATE) },
            { name: 'cut-off.msg', bytes: entry.goodMsg().slice(0, 700) },
        ];
        const results = await entry.parseFiles(files);
        return results.map((r): Summary =>
            r.ok
                ? {
                    fileName: r.message.source.fileName,
                    ok: true,
                    kind: r.message.source.kind,
                    warnings: [...r.message.warnings],
                    utcMs: r.message.date.utcMs,
                    bodyLooksConverted: r.message.bodyText.length > 0 && !/<\/?[a-z][^>]*>/i.test(r.message.bodyText),
                    hashed: /^[0-9a-f]{64}$/.test(r.message.source.sha256),
                }
                : { fileName: r.fileName, ok: false, error: r.error, detail: r.detail, hashed: r.sha256 !== null },
        );
    }, entryUrl);

    expect(summaries.map((s) => s.fileName)).toEqual([
        'plain.eml',
        'good.msg',
        'looping.msg',
        'notes.txt',
        'empty.eml',
        'huge.eml',
        'html-only.eml',
        'no-date.eml',
        'bad-date.eml',
        'cut-off.msg',
    ]);
    const [plain, good, looping, notes, empty, huge, html, noDate, badDate, cutOff] = summaries;
    expect(plain).toMatchObject({ ok: true, kind: 'eml', hashed: true });
    expect(good).toMatchObject({ ok: true, kind: 'msg', hashed: true });
    // Rejected by the Compound File check before msgreader could loop on it.
    expect(looping).toEqual({
        fileName: 'looping.msg',
        ok: false,
        error: 'corrupt',
        detail: 'damaged file structure: a sector chain loops back on itself',
        hashed: true,
    });
    expect(notes).toMatchObject({ ok: false, error: 'unsupported-type' });
    expect(empty).toMatchObject({ ok: false, error: 'corrupt', detail: 'the file is empty' });
    expect(huge).toEqual({
        fileName: 'huge.eml',
        ok: false,
        error: 'too-large',
        detail: 'the file is larger than 50 MB, the limit for one file',
        hashed: false,
    });
    // HTML converted on the page with DOMParser, after the worker asked for it.
    expect(html).toMatchObject({ ok: true, kind: 'eml', bodyLooksConverted: true });
    expect(html?.warnings).toContain('html-converted-body');
    // Missing / unparseable dates: no instant, flagged for the preview.
    expect(noDate).toMatchObject({ ok: true, utcMs: null });
    expect(noDate?.warnings).toContain('missing-date');
    expect(badDate).toMatchObject({ ok: true, utcMs: null });
    expect(badDate?.warnings).toContain('unparseable-date');
    expect(cutOff).toMatchObject({ ok: false, error: 'corrupt' });
    expect(cutOff?.detail).toMatch(/^damaged file structure: /);

    // One worker per file that reached a parser (not the unsupported, empty
    // and huge ones), and every one of them was terminated.
    expect(parseWorkers(workers)).toHaveLength(7);
    await expect.poll(() => parseWorkers(closedWorkers).length).toBe(7);

    await expectNoNetworkAndPageAlive(page);
});

test('a stuck worker is stopped at its time limit and a crashed one fails alone; the other files still parse', async ({ page }) =>
{
    test.setTimeout(60_000);
    await serveBundle(page);
    await open(page);

    const stuckStarted = page.waitForEvent('worker', (w) => w.url().includes('misbehaving-worker'));
    const batch = page.evaluate(async (url) =>
    {
        const entry = (await import(url)) as typeof Entry;
        const text = (s: string): Uint8Array => new TextEncoder().encode(s);
        const files: InputFile[] = [
            { name: 'first.eml', bytes: text(entry.FIXTURE_PLAIN) },
            { name: 'hang.eml', bytes: text(entry.FIXTURE_PLAIN) },
            { name: 'crash.eml', bytes: text(entry.FIXTURE_PLAIN) },
            { name: 'after.msg', bytes: entry.goodMsg() },
        ];
        const started = performance.now();
        // The real dispatcher; files named hang/crash go to the misbehaving
        // test worker (hang: with a shorter time limit), the others to the real
        // worker. The hang file's limit is long enough for the test below to
        // check the page while that worker is still spinning.
        const results = await entry.parseFilesWith(files, async (job) =>
        {
            const hang = /hang/.test(job.name);
            if (hang)
            {
                window.__e2eHang = 'running';
            }
            const result = await entry.runInWorker(job, {
                createWorker: /hang|crash/.test(job.name) ? entry.createMisbehavingParseWorker : entry.createBrowserWorker,
                htmlToText: (html) => entry.htmlToTextWithDomParser(html),
                timeoutMs: hang ? 4000 : entry.PARSE_TIMEOUT_MS,
            });
            if (hang)
            {
                window.__e2eHang = 'settled';
            }
            return result;
        });
        return {
            elapsedMs: performance.now() - started,
            results: results.map((r) => (r.ok ? { fileName: r.message.source.fileName, ok: true } : { fileName: r.fileName, ok: false, detail: r.detail, error: r.error })),
            timeoutDetail: entry.TIMEOUT_DETAIL,
            failedDetail: entry.WORKER_FAILED_DETAIL,
        };
    }, entryUrl);

    // While the stuck worker spins, the page still answers at once. The check
    // runs about 1 s after that worker started (time for it to load and start
    // its endless loop), well before its 4 s limit; the page confirms that the
    // file has no result yet, so the worker was still spinning, not already
    // terminated.
    const stuck = await stuckStarted;
    await page.waitForTimeout(1000);
    const before = Date.now();
    const during = await page.evaluate(() => ({ title: document.title, hang: window.__e2eHang }));
    expect(Date.now() - before).toBeLessThan(1000);
    expect(during).toEqual({ title: 'Email to PDF', hang: 'running' });

    const { elapsedMs, results, timeoutDetail, failedDetail } = await batch;
    expect(results).toEqual([
        { fileName: 'first.eml', ok: true },
        // Neither is called a damaged file: the time limit and the worker failure
        // have codes of their own.
        { fileName: 'hang.eml', ok: false, error: 'timeout', detail: timeoutDetail },
        { fileName: 'crash.eml', ok: false, error: 'tool-error', detail: failedDetail },
        { fileName: 'after.msg', ok: true },
    ]);
    expect(timeoutDetail).toBe('took too long to read (stopped)');
    expect(elapsedMs).toBeLessThan(15_000);
    // The stuck worker was terminated, not left spinning.
    await expect.poll(() => closedWorkers.includes(stuck)).toBe(true);
    await expect.poll(() => closedWorkers.length).toBe(workers.length);

    await expectNoNetworkAndPageAlive(page);
});

test('processFiles: File objects in, organized messages out; every worker ends and nothing leaves the page', async ({ page }) =>
{
    test.setTimeout(60_000);
    await serveBundle(page);
    await open(page);

    const outcome = await page.evaluate(async (url) =>
    {
        const entry = (await import(url)) as typeof Entry;
        const file = (name: string, text: string): File => new File([text], name);
        // A 51 MB file made of one 1 MB blob listed 51 times: the browser knows
        // its size without 51 MB being allocated, and reading it would be seen.
        const chunk = new Blob([new Uint8Array(1024 * 1024)]);
        const huge = new File(Array.from({ length: 51 }, () => chunk), 'huge.eml');
        let hugeRead = false;
        huge.arrayBuffer = () =>
        {
            hugeRead = true;
            return Blob.prototype.arrayBuffer.call(huge);
        };
        const files = [
            file('order-1.eml', entry.FIXTURE_ORDER_1),
            file('order-2.eml', entry.FIXTURE_ORDER_2),
            file('order-2-copy.eml', entry.FIXTURE_ORDER_2_COPY),
            file('notes.txt', 'Order notes, not an email.'),
            huge,
            file('order-3.eml', entry.FIXTURE_ORDER_3),
            new File([entry.goodMsg().slice()], 'good.msg'),
        ];
        const progress: ProcessProgress[] = [];
        const result = await entry.processFiles(files, { onProgress: (p) => progress.push(p) });
        if (!result.ok)
        {
            return { ok: false as const, detail: result.detail };
        }
        return {
            ok: true as const,
            hugeRead,
            progress,
            counts: result.threadAnalysis.counts,
            kept: result.threadAnalysis.messages.map((m) => m.message.source.fileName),
            duplicateOf2: result.threadAnalysis.messages.find((m) => m.message.source.fileName === 'order-2.eml')
                ?.duplicates.map((d) => d.source.fileName),
            failed: result.threadAnalysis.failed.map((f) => [f.index, f.fileName, f.error, f.detail]),
            tooLargeDetail: entry.FILE_TOO_LARGE_DETAIL,
        };
    }, entryUrl);

    if (!outcome.ok)
    {
        throw new Error(outcome.detail);
    }
    expect(outcome.hugeRead).toBe(false);
    expect(outcome.counts).toMatchObject({ filesGiven: 7, messagesFound: 5, duplicatesMerged: 1, filesFailed: 2 });
    expect(outcome.kept).toHaveLength(4);
    // The thread keeps its chronological order.
    const thread = outcome.kept.filter((name) => name.startsWith('order-'));
    expect(thread).toEqual(['order-1.eml', 'order-2.eml', 'order-3.eml']);
    expect(outcome.duplicateOf2).toEqual(['order-2-copy.eml']);
    expect(outcome.failed).toEqual([
        [3, 'notes.txt', 'unsupported-type', 'not an email file: only .eml and .msg files can be read'],
        [4, 'huge.eml', 'too-large', outcome.tooLargeDetail],
    ]);
    expect(outcome.progress.at(0)).toEqual({ stage: 'reading', filesDone: 0, filesTotal: 7 });
    expect(outcome.progress.at(-2)).toEqual({ stage: 'reading', filesDone: 7, filesTotal: 7 });
    expect(outcome.progress.at(-1)).toEqual({ stage: 'organizing', filesDone: 7, filesTotal: 7 });

    // One parse worker per email file that was read (not notes.txt, not the
    // huge one), one thread-analysis worker, and every one of them terminated.
    expect(parseWorkers(workers)).toHaveLength(5);
    expect(threadAnalysisWorkers(workers)).toHaveLength(1);
    await expect.poll(() => closedWorkers.length).toBe(workers.length);
    expect(workers).toHaveLength(6);

    await expectNoNetworkAndPageAlive(page);
});

test('a stuck thread-analysis worker is stopped at its time limit and a crashed one fails cleanly: a batch error, never a frozen page', async ({ page }) =>
{
    test.setTimeout(60_000);
    await serveBundle(page);
    await open(page);

    const stuckStarted = page.waitForEvent('worker', (w) => w.url().includes('misbehaving-worker'));
    const batch = page.evaluate(async (url) =>
    {
        const entry = (await import(url)) as typeof Entry;
        const limits = { maxFileBytes: entry.MAX_FILE_BYTES, maxBatchBytes: entry.MAX_FILE_BYTES * 10 };
        const files = [new File([entry.FIXTURE_PLAIN], 'plain.eml')];
        const started = performance.now();
        window.__e2eHang = 'running';
        // The real reading and parse workers; the thread-analysis worker replaced by one
        // that spins forever, with a 4 s limit instead of 60 s.
        const hang = await entry.processFilesWith(files, {
            parse: entry.parseFiles,
            organize: (results) =>
                entry.runThreadAnalysisInWorker(results, { createWorker: entry.createMisbehavingThreadAnalysisWorker('hang'), timeoutMs: 4000 }),
            limits,
        });
        window.__e2eHang = 'settled';
        const elapsedMs = performance.now() - started;
        const crash = await entry.processFilesWith(files, {
            parse: entry.parseFiles,
            organize: (results) =>
                entry.runThreadAnalysisInWorker(
                    results, { createWorker: entry.createMisbehavingThreadAnalysisWorker('crash'), timeoutMs: entry.THREAD_ANALYSIS_TIMEOUT_MS }),
            limits,
        });
        const summary = (r: ProcessResult) => (r.ok ? { ok: true } : { ok: false, error: r.error, detail: r.detail, parsed: r.parsed.map((p) => p.ok) });
        return { elapsedMs, hang: summary(hang), crash: summary(crash), timeoutDetail: entry.THREAD_ANALYSIS_TIMEOUT_DETAIL, failedDetail: entry.THREAD_ANALYSIS_FAILED_DETAIL };
    }, entryUrl);

    // While the thread-analysis worker spins, the page still answers at once (checked
    // about 1 s after that worker started, well before its 4 s limit).
    const stuck = await stuckStarted;
    await page.waitForTimeout(1000);
    const before = Date.now();
    const during = await page.evaluate(() => ({ title: document.title, hang: window.__e2eHang }));
    expect(Date.now() - before).toBeLessThan(1000);
    expect(during).toEqual({ title: 'Email to PDF', hang: 'running' });

    const { elapsedMs, hang, crash, timeoutDetail, failedDetail } = await batch;
    expect(hang).toEqual({ ok: false, error: 'engine-timeout', detail: timeoutDetail, parsed: [true] });
    expect(crash).toEqual({ ok: false, error: 'engine-failed', detail: failedDetail, parsed: [true] });
    expect(elapsedMs).toBeLessThan(15_000);
    await expect.poll(() => closedWorkers.includes(stuck)).toBe(true);
    await expect.poll(() => closedWorkers.length).toBe(workers.length);

    await expectNoNetworkAndPageAlive(page);
});

/** Starts an idle parse, thread-analysis or PDF worker in the page (kept alive on window) and returns its Playwright handle. */
async function startIdleWorker(page: Page, which: 'parse' | 'engine' | 'pdf'): Promise<Worker>
{
    // Only one worker is started here, so the next one seen is it (its blob:
    // URL is not known in advance); its name is checked once it is known.
    const started = page.waitForEvent('worker');
    await page.evaluate(
        async ({ url, kind }) =>
        {
            const entry = (await import(url)) as typeof Entry;
            const events = { message: () => undefined, failure: () => undefined };
            window.__e2eKeep =
                kind === 'parse'
                    ? entry.createBrowserWorker(events)
                    : kind === 'engine'
                        ? entry.createBrowserThreadAnalysisWorker(events)
                        : entry.createBrowserPdfWorker(events);
        },
        { url: entryUrl, kind: which },
    );
    const worker = await started;
    expect(worker.url()).toMatch(new RegExp(`^blob:${origin}/`));
    await expect.poll(() => workerNames.get(worker.url())).toBe(`${which}-worker`);
    return worker;
}

/**
 * From inside `worker`: a remote and a same-origin fetch; returns how each
 * ended and the CSP violations seen there. The same-origin URL is absolute:
 * a relative one cannot be resolved against a blob: URL.
 */
function tryFetchesInWorker(worker: Worker, siteOrigin: string): Promise<{ outcomes: string[]; violations: string[] }>
{
    return worker.evaluate(async (base) =>
    {
        const violations: string[] = [];
        self.addEventListener('securitypolicyviolation', (event) =>
        {
            violations.push(`${event.effectiveDirective} ${event.blockedURI} | ${event.originalPolicy}`);
        });
        const outcomes: string[] = [];
        for (const target of ['https://example.invalid/from-worker', `${base}/same-origin-from-worker`])
        {
            try
            {
                await fetch(target);
                outcomes.push('resolved');
            }
            catch
            {
                outcomes.push('rejected');
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { outcomes, violations };
    }, siteOrigin);
}

// Positive controls for the checks above, for each kind of worker the
// page starts (parse, thread analysis as 'engine' after its runtime name 'engine-worker', and PDF). A blob: worker takes the CSP of the page
// that starts it, so these change the PAGE's CSP. Seen in Chromium: with the
// header and the <meta> tag, the worker is bound by BOTH policies (each
// reports the violation); with the <meta> tag alone, by that one. So unlike a
// worker loaded from its own file, a blob: worker stays covered on a host
// that can only use the <meta> fallback.
for (const which of ['parse', 'engine', 'pdf'] as const)
{
    for (const csp of ['header and meta', 'meta'] as const)
    {
        // The worker really runs under the site's strict CSP, and its violations
        // really reach the detector used after each batch (worker log entries
        // over CDP), so "no violation" above means something.
        test(`the ${which} worker runs under the page's strict CSP (${csp}), and the detectors see its violations`, async ({ page, browserName }) =>
        {
            await serveBundle(page);
            await servePageWith(page, csp);
            await open(page);
            const worker = await startIdleWorker(page, which);
            const { outcomes, violations } = await tryFetchesInWorker(worker, origin);

            expect(outcomes).toEqual(['rejected', 'rejected']);
            const policies = csp === 'meta' ? [cspForMeta()] : [cspForHeader(), cspForMeta()];
            const expected = policies.flatMap((policy) => [
                `connect-src https://example.invalid/from-worker | ${policy}`,
                `connect-src ${origin}/same-origin-from-worker | ${policy}`,
            ]);
            expect(violations.sort()).toEqual(expected.sort());
            // The detectors used after each batch see them: the worker prelude in
            // every browser (exactly one line per report), and in Chromium also the
            // worker log entries over CDP.
            const name = `${which}-worker`;
            await expect
                .poll(() => workerCspReports().filter((line) => line.startsWith('securitypolicyviolation ')).sort())
                .toEqual(
                    policies
                        .flatMap(() => [
                            `securitypolicyviolation connect-src https://example.invalid/from-worker | ${name}`,
                            `securitypolicyviolation connect-src ${origin}/same-origin-from-worker | ${name}`,
                        ])
                        .sort(),
                );
            if (browserName === 'chromium')
            {
                const cdpLines = (): string[] => workerCspReports().filter((line) => !line.startsWith('securitypolicyviolation '));
                await expect.poll(() => cdpLines().filter((line) => line.includes('example.invalid/from-worker')).length).toBeGreaterThan(0);
                await expect.poll(() => cdpLines().filter((line) => line.includes('/same-origin-from-worker')).length).toBeGreaterThan(0);
            }
            // Blocked by the CSP before any request was made.
            expect(requestsAfterLoad()).toEqual([]);
            // The page itself saw nothing: its listener does not see worker violations.
            expect(await page.evaluate(() => window.__e2eViolations)).toEqual([]);
        });
    }

    // Context-level request tracking sees requests made by the worker. The
    // page is served with NO CSP at all here (no header, no <meta>), so the
    // worker has none either and its fetches really become requests (the
    // remote one is aborted by the safety net, never sent).
    test(`request tracking sees requests made inside the ${which} worker`, async ({ page }) =>
    {
        await serveBundle(page);
        await servePageWith(page, 'none');
        await open(page);
        const worker = await startIdleWorker(page, which);
        const { outcomes, violations } = await tryFetchesInWorker(worker, origin);

        expect(outcomes).toEqual(['rejected', 'resolved']);
        expect(violations).toEqual([]);
        await expect.poll(() => requestsAfterLoad().sort()).toEqual(
            ['https://example.invalid/from-worker', `${origin}/same-origin-from-worker`].sort(),
        );
    });
}
