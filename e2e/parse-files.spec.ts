// Browser test of the parse pipeline (README.md, rules R1, R2 and R4): every
// dropped file is parsed in its own Web Worker with a time limit, and broken,
// huge or hostile files give a clear per-file result without ever crashing
// the batch or the page. The engine then organizes the results in its own
// worker (src/pipeline/engine-worker.ts), also with a time limit; processFiles
// (src/pipeline/process-files.ts) chains it all from browser File objects.
// Runs in Chromium against the site served by `vite preview` (see
// playwright.config.ts).
//
// How the code gets into the page without shipping a test hook:
// the pipeline is not wired into the page yet (that comes with the preview
// UI), so the built site does not contain it. beforeAll bundles
// e2e/support/parse-entry.ts IN MEMORY (`write: false`) with the project's
// own vite.config.ts, the same configuration as the production build. Vite
// emits the parse worker and the engine worker as separate script files,
// exactly as it will in dist/. A Playwright route serves the bundle at /__e2e__/... on the site's
// own origin, WITH the site's real security headers: a worker takes its CSP
// from its own script's response (the page's <meta> CSP does not apply to
// it), and in production every file is sent with the CSP header (dist/_headers,
// `/*`). Nothing is written to dist/ and the CSP is unchanged.
//
// What these tests rely on to see worker activity (the page-level
// `securitypolicyviolation` listener and `routeWebSocket` do NOT see what a
// worker does):
// - context-level request tracking, which includes requests made by workers
//   (proved by a positive control below);
// - page.on('worker') to follow every worker and its 'close' event
//   (terminated);
// - a CDP session that attaches to every worker of the page before its script
//   runs and enables the `Log` domain, where Chromium reports each CSP
//   violation of that worker ("Refused to connect ..."). Playwright's worker
//   'console' event does not carry these reports (seen in Chromium);
// - a `securitypolicyviolation` listener installed INSIDE a worker with
//   worker.evaluate, for the positive control.
// Requests are re-checked after processing has finished and a quiet period,
// not only at page load.
import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { build, type Rolldown } from 'vite';
import { findViolations } from '../scripts/no-network-rules.mjs';
import { cspForHeader, PERMISSIONS_POLICY, REFERRER_POLICY } from '../src/security/headers.ts';
import type * as Entry from './support/parse-entry.ts';

declare global {
  interface Window {
    /** "directive blockedURI" of each CSP violation in the page. */
    __e2eViolations: string[];
    /** Keeps a test worker alive for the positive controls. */
    __e2eKeep: unknown;
    /** Whether the stuck test worker's job is still running ('running') or has its result ('settled'). */
    __e2eHang: 'running' | 'settled' | undefined;
  }
}

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const BUNDLE_PATH = '/__e2e__/';

/** CSP reports Chromium makes while DOMParser PARSES inline handlers, styles and <base> (nothing runs). */
const PARSE_TIME_DIRECTIVES = new Set(['script-src-attr', 'style-src-elem', 'style-src-attr', 'base-uri']);

/** The in-memory test bundle: path below BUNDLE_PATH -> file contents. */
const bundle = new Map<string, string>();
let entryUrl = '';
let parseWorkerFile = '';
let engineWorkerFile = '';

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const output = await build({
    root: ROOT,
    configFile: `${ROOT}vite.config.ts`,
    mode: 'production',
    logLevel: 'warn',
    base: BUNDLE_PATH,
    build: {
      write: false, // in memory only: dist/ is never touched
      emptyOutDir: false,
      copyPublicDir: false,
      rolldownOptions: { input: `${ROOT}e2e/support/parse-entry.ts`, preserveEntrySignatures: 'exports-only' },
    },
  });
  const outputs = (Array.isArray(output) ? output : [output]) as Rolldown.RolldownOutput[];
  for (const item of outputs.flatMap((o) => o.output)) {
    const code = item.type === 'chunk' ? item.code : typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source);
    bundle.set(item.fileName, code);
    if (item.type === 'chunk' && item.isEntry) entryUrl = `${BUNDLE_PATH}${item.fileName}`;
    if (/^assets\/parse-worker-[\w-]+\.js$/.test(item.fileName)) parseWorkerFile = item.fileName;
    if (/^assets\/engine-worker-[\w-]+\.js$/.test(item.fileName)) engineWorkerFile = item.fileName;
  }
  expect(entryUrl).not.toBe('');
  expect(parseWorkerFile).not.toBe('');
  expect(engineWorkerFile).not.toBe('');
});

let origin = '';
let requestUrls: string[] = [];
/** requestUrls.length once the page had loaded. */
let loadedAt = 0;
let websockets: string[] = [];
let workers: Worker[] = [];
let closedWorkers: Worker[] = [];
/** Log entries (CSP reports, ...) of every worker, as "source level | text". */
let workerLog: string[] = [];

/** Records every request of the context (pages and their workers); aborts anything that leaves the preview server. */
async function watchNetwork(context: BrowserContext): Promise<void> {
  context.on('request', (request) => requestUrls.push(request.url()));
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'),
  );
  await context.routeWebSocket(/.*/, async (ws) => {
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

/**
 * Serves the in-memory test bundle on the site's own origin, with the site's
 * security headers. `withoutCspFor` names bundle files sent WITHOUT the CSP
 * header (positive control only).
 */
async function serveBundle(page: Page, withoutCspFor: readonly string[] = []): Promise<void> {
  await page.route(`**${BUNDLE_PATH}**`, async (route) => {
    const name = new URL(route.request().url()).pathname.slice(BUNDLE_PATH.length);
    const code = bundle.get(name);
    if (code === undefined) {
      await route.fulfill({ status: 404, headers: SITE_HEADERS });
      return;
    }
    const headers: Record<string, string> = { ...SITE_HEADERS };
    if (withoutCspFor.includes(name)) delete headers['Content-Security-Policy'];
    await route.fulfill({ body: code, contentType: 'text/javascript', headers });
  });
}

/**
 * Follows every worker the page starts: its end (page.on('worker')), and its
 * log entries through CDP. The CDP session auto-attaches to each new worker
 * paused before its script runs (waitForDebuggerOnStart), enables the Log
 * domain, then lets it run, so no entry can be missed. `flatten: false`
 * routes the worker's messages through this one session
 * (Target.sendMessageToTarget), which Playwright's CDPSession supports.
 */
async function watchWorkers(context: BrowserContext, page: Page): Promise<void> {
  page.on('worker', (worker) => {
    workers.push(worker);
    worker.on('close', () => closedWorkers.push(worker));
  });
  const cdp = await context.newCDPSession(page);
  let nextId = 0;
  cdp.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    const send = (method: string): void => {
      void cdp
        .send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: ++nextId, method, params: {} }) })
        .catch(() => undefined); // the worker may already be gone
    };
    if (targetInfo.type === 'worker') send('Log.enable');
    send('Runtime.runIfWaitingForDebugger');
  });
  cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
    const parsed = JSON.parse(message) as { method?: string; params?: { entry?: { source: string; level: string; text: string } } };
    const entry = parsed.params?.entry;
    if (parsed.method === 'Log.entryAdded' && entry !== undefined) workerLog.push(`${entry.source} ${entry.level} | ${entry.text}`);
  });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
}

/** Worker log entries that report a CSP violation. */
const workerCspReports = (): string[] => workerLog.filter((line) => /Content Security Policy|Refused to/i.test(line));

test.beforeEach(async ({ context, page, baseURL }) => {
  origin = new URL(baseURL ?? '').origin;
  requestUrls = [];
  loadedAt = 0;
  websockets = [];
  workers = [];
  closedWorkers = [];
  workerLog = [];
  await watchNetwork(context);
  await watchWorkers(context, page);
  await page.addInitScript(() => {
    window.__e2eViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__e2eViolations.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
});

async function open(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'networkidle' });
  loadedAt = requestUrls.length;
}

/** Requests since the page loaded, except the test bundle's own files. */
function requestsAfterLoad(): string[] {
  return requestUrls.slice(loadedAt).filter((url) => !(new URL(url).origin === origin && new URL(url).pathname.startsWith(BUNDLE_PATH)));
}

/** The parse workers (not the test's misbehaving worker) seen so far. */
const parseWorkers = (list: readonly Worker[]): Worker[] => list.filter((w) => w.url() === `${origin}${BUNDLE_PATH}${parseWorkerFile}`);
/** The engine workers seen so far. */
const engineWorkers = (list: readonly Worker[]): Worker[] => list.filter((w) => w.url() === `${origin}${BUNDLE_PATH}${engineWorkerFile}`);

/**
 * After processing has finished: waits a quiet period, then asserts that
 * nothing (page or worker) made a request, opened a WebSocket or triggered a
 * CSP violation, and that the page is still alive.
 */
async function expectNoNetworkAndPageAlive(page: Page): Promise<void> {
  await page.waitForTimeout(1000);
  expect(requestsAfterLoad()).toEqual([]);
  expect(websockets).toEqual([]);
  // In the page, only the parse-time reports DOMParser makes for inline
  // handlers, <style> blocks and <base> in email HTML are expected: nothing
  // runs or loads (see e2e/html-to-text.spec.ts, which proves it with and
  // without the CSP). Anything else would be an attempted load or execution.
  const pageViolations = await page.evaluate(() => window.__e2eViolations);
  expect(pageViolations.filter((v) => !PARSE_TIME_DIRECTIVES.has(v.split(' ')[0] ?? ''))).toEqual([]);
  expect(workerCspReports()).toEqual([]);
  expect(await page.title()).toBe('Email to PDF');
  expect(await page.evaluate(() => 6 * 7)).toBe(42);
}

/** What the tests compare of each result (plain data, no message text beyond what is checked). */
interface Summary {
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

test('the parse and engine workers are separate same-origin script files with no network code', () => {
  // Same configuration as the production build: each worker must be its own
  // file (allowed by `worker-src 'self'`), never inlined as a blob: or data:
  // URL, and must pass the same no-network/URL scan as every dist/ file.
  for (const file of [parseWorkerFile, engineWorkerFile]) {
    const workerCode = bundle.get(file) ?? '';
    expect(workerCode.length, file).toBeGreaterThan(1000);
    expect(findViolations(workerCode, { isDist: true, distFile: file }), file).toEqual([]);
    // One self-contained file: no module imports, no script loading, no eval
    // (each would need more than `script-src 'self'`, or a request).
    expect(workerCode, file).not.toMatch(/\bimport\s*[({"'*]|\bimportScripts\b|(?<![\w$.])eval\s*\(|\bnew Function\b/);
  }

  // Every worker the entry starts is a bundled file on the site's own origin.
  const entryCode = bundle.get(entryUrl.slice(BUNDLE_PATH.length)) ?? '';
  const allWorkers = entryCode.match(/new Worker\(/g) ?? [];
  const fileWorkers = [...entryCode.matchAll(/new Worker\(new URL\(`(\/__e2e__\/assets\/[\w-]+\.js)`/g)].map((m) => m[1]);
  expect(fileWorkers).toContain(`${BUNDLE_PATH}${parseWorkerFile}`);
  expect(fileWorkers).toContain(`${BUNDLE_PATH}${engineWorkerFile}`);
  expect(fileWorkers).toHaveLength(allWorkers.length);
});

test('a batch with broken, huge and unsupported files: one result per file, in order, and the page survives', async ({ page }) => {
  test.setTimeout(60_000);
  await serveBundle(page);
  await open(page);

  const summaries = await page.evaluate(async (url) => {
    const entry = (await import(url)) as typeof Entry;
    const text = (s: string): Uint8Array => new TextEncoder().encode(s);
    const files: Entry.InputFile[] = [
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

test('a stuck worker is stopped at its time limit and a crashed one fails alone; the other files still parse', async ({ page }) => {
  test.setTimeout(60_000);
  await serveBundle(page);
  await open(page);

  const stuckStarted = page.waitForEvent('worker', (w) => w.url().includes('misbehaving-worker'));
  const batch = page.evaluate(async (url) => {
    const entry = (await import(url)) as typeof Entry;
    const text = (s: string): Uint8Array => new TextEncoder().encode(s);
    const files: Entry.InputFile[] = [
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
    const results = await entry.parseFilesWith(files, async (job) => {
      const hang = /hang/.test(job.name);
      if (hang) window.__e2eHang = 'running';
      const result = await entry.runInWorker(job, {
        createWorker: /hang|crash/.test(job.name) ? entry.createMisbehavingWorker : entry.createBrowserWorker,
        htmlToText: (html) => entry.htmlToTextWithDomParser(html),
        timeoutMs: hang ? 4000 : entry.PARSE_TIMEOUT_MS,
      });
      if (hang) window.__e2eHang = 'settled';
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
    { fileName: 'hang.eml', ok: false, error: 'corrupt', detail: timeoutDetail },
    { fileName: 'crash.eml', ok: false, error: 'corrupt', detail: failedDetail },
    { fileName: 'after.msg', ok: true },
  ]);
  expect(timeoutDetail).toBe('took too long to read (stopped)');
  expect(elapsedMs).toBeLessThan(15_000);
  // The stuck worker was terminated, not left spinning.
  await expect.poll(() => closedWorkers.includes(stuck)).toBe(true);
  await expect.poll(() => closedWorkers.length).toBe(workers.length);

  await expectNoNetworkAndPageAlive(page);
});

test('processFiles: File objects in, organized messages out; every worker ends and nothing leaves the page', async ({ page }) => {
  test.setTimeout(60_000);
  await serveBundle(page);
  await open(page);

  const outcome = await page.evaluate(async (url) => {
    const entry = (await import(url)) as typeof Entry;
    const file = (name: string, text: string): File => new File([text], name);
    // A 51 MB file made of one 1 MB blob listed 51 times: the browser knows
    // its size without 51 MB being allocated, and reading it would be seen.
    const chunk = new Blob([new Uint8Array(1024 * 1024)]);
    const huge = new File(Array.from({ length: 51 }, () => chunk), 'huge.eml');
    let hugeRead = false;
    huge.arrayBuffer = () => {
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
    const progress: Entry.ProcessProgress[] = [];
    const result = await entry.processFiles(files, { onProgress: (p) => progress.push(p) });
    if (!result.ok) return { ok: false as const, detail: result.detail };
    return {
      ok: true as const,
      hugeRead,
      progress,
      counts: result.engine.counts,
      kept: result.engine.messages.map((m) => m.message.source.fileName),
      duplicateOf2: result.engine.messages.find((m) => m.message.source.fileName === 'order-2.eml')?.duplicates.map((d) => d.source.fileName),
      failed: result.engine.failed.map((f) => [f.index, f.fileName, f.error, f.detail]),
      tooLargeDetail: entry.FILE_TOO_LARGE_DETAIL,
    };
  }, entryUrl);

  if (!outcome.ok) throw new Error(outcome.detail);
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
  // huge one), one engine worker, and every one of them terminated.
  expect(parseWorkers(workers)).toHaveLength(5);
  expect(engineWorkers(workers)).toHaveLength(1);
  await expect.poll(() => closedWorkers.length).toBe(workers.length);
  expect(workers).toHaveLength(6);

  await expectNoNetworkAndPageAlive(page);
});

test('a stuck engine worker is stopped at its time limit and a crashed one fails cleanly: a batch error, never a frozen page', async ({ page }) => {
  test.setTimeout(60_000);
  await serveBundle(page);
  await open(page);

  const stuckStarted = page.waitForEvent('worker', (w) => w.url().includes('misbehaving-worker'));
  const batch = page.evaluate(async (url) => {
    const entry = (await import(url)) as typeof Entry;
    const limits = { maxFileBytes: entry.MAX_FILE_BYTES, maxBatchBytes: entry.MAX_FILE_BYTES * 10 };
    const files = [new File([entry.FIXTURE_PLAIN], 'plain.eml')];
    const started = performance.now();
    window.__e2eHang = 'running';
    // The real reading and parse workers; the engine worker replaced by one
    // that spins forever, with a 4 s limit instead of 60 s.
    const hang = await entry.processFilesWith(files, {
      parse: entry.parseFiles,
      organize: (results) => entry.runEngineInWorker(results, { createWorker: entry.createMisbehavingEngineWorker('hang'), timeoutMs: 4000 }),
      limits,
    });
    window.__e2eHang = 'settled';
    const elapsedMs = performance.now() - started;
    const crash = await entry.processFilesWith(files, {
      parse: entry.parseFiles,
      organize: (results) =>
        entry.runEngineInWorker(results, { createWorker: entry.createMisbehavingEngineWorker('crash'), timeoutMs: entry.ENGINE_TIMEOUT_MS }),
      limits,
    });
    const summary = (r: Entry.ProcessResult) => (r.ok ? { ok: true } : { ok: false, error: r.error, detail: r.detail, parsed: r.parsed.map((p) => p.ok) });
    return { elapsedMs, hang: summary(hang), crash: summary(crash), timeoutDetail: entry.ENGINE_TIMEOUT_DETAIL, failedDetail: entry.ENGINE_FAILED_DETAIL };
  }, entryUrl);

  // While the engine worker spins, the page still answers at once (checked
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

/** Starts an idle parse or engine worker in the page (kept alive on window) and returns its Playwright handle. */
async function startIdleWorker(page: Page, which: 'parse' | 'engine'): Promise<Worker> {
  const file = which === 'parse' ? parseWorkerFile : engineWorkerFile;
  const started = page.waitForEvent('worker', (w) => w.url().endsWith(file));
  await page.evaluate(
    async ({ url, kind }) => {
      const entry = (await import(url)) as typeof Entry;
      const events = { message: () => undefined, failure: () => undefined };
      window.__e2eKeep = kind === 'parse' ? entry.createBrowserWorker(events) : entry.createBrowserEngineWorker(events);
    },
    { url: entryUrl, kind: which },
  );
  return started;
}

/** From inside `worker`: a remote and a same-origin fetch; returns how each ended and the CSP violations seen there. */
function tryFetchesInWorker(worker: Worker): Promise<{ outcomes: string[]; violations: string[] }> {
  return worker.evaluate(async () => {
    const violations: string[] = [];
    self.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.effectiveDirective} ${event.blockedURI} | ${event.originalPolicy}`);
    });
    const outcomes: string[] = [];
    for (const target of ['https://example.invalid/from-worker', '/same-origin-from-worker']) {
      try {
        await fetch(target);
        outcomes.push('resolved');
      } catch {
        outcomes.push('rejected');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { outcomes, violations };
  });
}

// Positive controls for the checks above, for each kind of worker the
// pipeline starts (parse and engine).
for (const which of ['parse', 'engine'] as const) {
  // The worker really runs under the site's strict CSP, and its violations
  // really reach the detector used after each batch (worker log entries over
  // CDP), so "no violation" above means something.
  test(`the ${which} worker runs under the strict CSP, and the detectors see its violations`, async ({ page }) => {
    await serveBundle(page);
    await open(page);
    const worker = await startIdleWorker(page, which);
    const { outcomes, violations } = await tryFetchesInWorker(worker);

    expect(outcomes).toEqual(['rejected', 'rejected']);
    const policy = cspForHeader();
    expect(violations.sort()).toEqual(
      [`connect-src https://example.invalid/from-worker | ${policy}`, `connect-src ${origin}/same-origin-from-worker | ${policy}`].sort(),
    );
    // The detector used after each batch (worker log entries over CDP) sees them.
    await expect.poll(() => workerCspReports().filter((line) => line.includes('example.invalid/from-worker')).length).toBeGreaterThan(0);
    await expect.poll(() => workerCspReports().filter((line) => line.includes('/same-origin-from-worker')).length).toBeGreaterThan(0);
    // Blocked by the CSP before any request was made.
    expect(requestsAfterLoad()).toEqual([]);
    // The page itself saw nothing: its listener does not see worker violations.
    expect(await page.evaluate(() => window.__e2eViolations)).toEqual([]);
  });

  // Context-level request tracking sees requests made by the worker. Its
  // script is served WITHOUT its CSP header here, so its fetch really becomes
  // a request (aborted by the safety net, never sent).
  test(`request tracking sees requests made inside the ${which} worker`, async ({ page }) => {
    await serveBundle(page, [which === 'parse' ? parseWorkerFile : engineWorkerFile]);
    await open(page);
    const worker = await startIdleWorker(page, which);
    const { outcomes, violations } = await tryFetchesInWorker(worker);

    expect(outcomes).toEqual(['rejected', 'resolved']);
    expect(violations).toEqual([]);
    await expect.poll(() => requestsAfterLoad().sort()).toEqual(
      ['https://example.invalid/from-worker', `${origin}/same-origin-from-worker`].sort(),
    );
  });
}
