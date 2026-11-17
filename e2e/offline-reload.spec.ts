// Browser test of the service worker (Source/offline-copy/; README.md, "How the privacy
// model works", rules R1, R2 and R5), in each test browser against the
// BUILT site served by `vite preview` (see playwright.config.ts). Service
// workers are blocked in every other spec; this one allows them.
//
// - the whole journey: the page opened once with the network on, the
//   service worker in charge of it, then the network OFF, the page
//   RELOADED, and the whole tool used from the stored copy: files added,
//   preview, PDF made and downloaded. Throughout: no request outside the
//   site, every request after the reload answered by the service worker
//   (nothing reached the network), no CSP violation in the page or a
//   worker, no console error. Cache Storage holds exactly the precache
//   list, which is exactly the built files (minus host settings files,
//   source maps and sw.js, with index.html as "/"), before AND after the emails: nothing is stored at
//   run time. Offline, a listed file opens, an unlisted address or a
//   "?..." variant does not (the service worker leaves them alone).
//   "Offline" is context.setOffline in Chromium and WebKit; in Firefox,
//   every request that reaches the network is aborted instead (see
//   goOffline for why).
// - /sw.js is served with its own CSP, the page's with only
//   connect-src 'self'; every other file keeps the page's; the list in
//   sw.js is exactly the built files. In Chromium (the only browser where
//   Playwright reaches a service worker), a positive control: from inside
//   the service worker, a request to another site is blocked BY ITS CSP,
//   one to the site itself is not. Also in Chromium, online: an unlisted
//   address (/index.html) and "?..." variants are answered by the site,
//   not by the service worker; a listed file is answered from the copy.
// - a refused registration, and (Chromium, WebKit) a missing sw.js, are
//   calm: no console error from the app, the tool works. A later
//   registration deletes older caches of this service worker only, never
//   another cache.
//
// Test data is made up: tests/fixtures/eml (invented people, *.test addresses).
import { readdirSync, readFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page, type Request, type Route } from '@playwright/test';
import { cspForHeader, cspForMeta, cspForServiceWorker, PERMISSIONS_POLICY, REFERRER_POLICY } from '../Source/security-headers/headers.ts';
import { en } from '../Source/page/translations/en.ts';
import {
    engineOf,
    untoleratedReports,
    watchPage,
    withoutSelectConsole,
    withoutSelectReports,
    workerCspReports,
    workersNamed,
    type Watch,
} from './support/watch.ts';

declare global
{
    interface Window
    {
        __offlineViolations: string[];
    }
}

test.use({ serviceWorkers: 'allow' });

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

/** Node's Buffer (see e2e/add-files.spec.ts): what setInputFiles wants for in-memory files. */
const NodeBuffer = (globalThis as unknown as { Buffer: { from(bytes: Uint8Array): Uint8Array } }).Buffer;
const fixture = (name: string) => ({
    name,
    mimeType: 'message/rfc822',
    buffer: NodeBuffer.from(new TextEncoder().encode(readFileSync(`${ROOT}tests/fixtures/eml/${name}`, 'utf8'))) as never,
});
const FILES = [fixture('10-order-1-alice.eml'), fixture('11-order-2-bob-outlook-en.eml'), fixture('12-order-3-alice-gmail.eml'), fixture('70-no-date.eml')];

/**
 * The precache list the build must have made, worked out here from dist/
 * on its own: every built file, index.html as "/", minus the host settings
 * files (_headers, _redirects, _routes.json), source maps and sw.js.
 */
function expectedPaths(): string[]
{
    const dist = `${ROOT}dist`;
    const left = new Set(['_headers', '_redirects', '_routes.json', 'sw.js']);
    return readdirSync(dist, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => `${entry.parentPath}/${entry.name}`.replaceAll('\\', '/').slice(dist.length + 1))
        .filter((name) => !left.has(name) && !name.endsWith('.map'))
        .map((name) => (name === 'index.html' ? '/' : `/${name}`))
        .sort();
}

let origin = '';
let watch: Watch;
/** Every request of the context, as Playwright objects (watch.requests has only their URLs). */
let requestObjects: Request[] = [];
let problems: string[] = [];

test.beforeEach(async ({ context, page, baseURL }) =>
{
    origin = new URL(baseURL ?? '').origin;
    problems = [];
    requestObjects = [];
    watch = await watchPage(context, page, origin);
    context.on('request', (request) => requestObjects.push(request));
    page.on('console', (message) =>
    {
        if (message.type() === 'error')
        {
            problems.push(`console: ${message.text()}`);
        }
    });
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('dialog', (dialog) =>
    {
        problems.push(`dialog: ${dialog.message()}`);
        void dialog.dismiss();
    });
    await page.addInitScript(() =>
    {
        window.__offlineViolations = [];
        document.addEventListener('securitypolicyviolation', (event) =>
        {
            // "select": WebKit's report about a <select> (see withoutSelectReports).
            const where = event.target === document ? 'parse' : event.target instanceof HTMLSelectElement ? 'select' : 'live';
            window.__offlineViolations.push(`${event.effectiveDirective} ${event.blockedURI} ${where}`);
        });
    });
});

/** Waits until a service worker controls the page; returns its script URL. */
async function waitForControl(page: Page): Promise<string>
{
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ''), { timeout: 30_000 }).not.toBe('');
    return page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? '');
}

/** Every cache of the site, with the URL paths it holds (sorted). */
function cacheContents(page: Page): Promise<Record<string, string[]>>
{
    return page.evaluate(async () =>
    {
        const result: Record<string, string[]> = {};
        for (const name of await caches.keys())
        {
            const cache = await caches.open(name);
            result[name] = (await cache.keys()).map((request) => new URL(request.url).pathname + new URL(request.url).search).sort();
        }
        return result;
    });
}

/** Adds the files and waits until the preview and the PDF button are ready. */
async function addFiles(page: Page): Promise<void>
{
    await page.locator('#file-input').setInputFiles(FILES);
    await expect(page.locator('#preview-list > li')).toHaveCount(FILES.length, { timeout: 60_000 });
    await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/, { timeout: 60_000 });
    await expect(page.getByRole('button', { name: en.actions.makePdf })).not.toHaveAttribute('aria-disabled', /.*/, { timeout: 60_000 });
}

/** Nothing outside the site, no WebSocket, no CSP report (page and workers), no console error. */
async function expectCleanRun(page: Page, loads: number): Promise<void>
{
    await page.waitForTimeout(500);
    expect(watch.requests.filter((url) => !url.startsWith(`blob:${origin}/`) && new URL(url).origin !== origin)).toEqual([]);
    expect(watch.websockets).toEqual([]);
    const browserName = engineOf(page.context());
    // One page load since the recorder was (re)installed: the reload starts it afresh.
    const violations = withoutSelectReports(browserName, await page.evaluate(() => window.__offlineViolations));
    expect(untoleratedReports(browserName, violations)).toEqual([]);
    expect(workerCspReports(watch)).toEqual([]);
    const named = (['parse-worker', 'engine-worker', 'pdf-worker'] as const).reduce((sum, name) => sum + workersNamed(watch, watch.workers, name).length, 0);
    expect(named).toBe(watch.workers.length);
    expect(withoutSelectConsole(browserName, problems, 2, loads)).toEqual([]);
}

/** Is `request` a blob: read (in memory, never the network)? */
const isBlob = (request: Request): boolean => request.url().startsWith(`blob:${origin}/`);

/**
 * Switches the network off. Chromium and WebKit: context.setOffline(true).
 * Firefox: Playwright's setOffline puts the tab in Firefox's own offline
 * mode, where a navigation fails with NS_ERROR_OFFLINE before any service
 * worker is asked (seen with the service worker in charge of the page), so
 * it cannot show what a real loss of network does. There, every request
 * that reaches the network is aborted instead, as a lost connection would
 * ('internetdisconnected'); a request the service worker answers never
 * reaches the network, so it is not affected. The checks after the reload
 * are the same in all three browsers.
 */
async function goOffline(context: BrowserContext): Promise<void>
{
    if (engineOf(context) !== 'firefox')
    {
        await context.setOffline(true);
        return;
    }
    // Registered after watchPage's safety net, so it runs first.
    await context.route('**/*', cutNetwork);
}

const cutNetwork = (route: Route): Promise<void> => route.abort('internetdisconnected');

async function goOnline(context: BrowserContext): Promise<void>
{
    if (engineOf(context) !== 'firefox')
    {
        await context.setOffline(false);
    }
    else
    {
        await context.unroute('**/*', cutNetwork);
    }
}

test('after one visit online, the page reloads offline and the whole tool works from the stored copy', async ({ context, page }) =>
{
    test.setTimeout(120_000);
    const paths = expectedPaths();
    expect(paths).toContain('/');
    expect(paths.some((path) => /^\/assets\/index-[\w-]+\.js$/.test(path))).toBe(true);
    expect(paths.some((path) => /^\/assets\/pdf-fonts-[\w-]+\.js$/.test(path))).toBe(true);

    // 1. Online: open the page, wait for the service worker to take charge.
    await page.goto('/', { waitUntil: 'load' });
    await expect(page.locator('#drop-zone')).toBeVisible();
    expect(await waitForControl(page)).toBe(`${origin}/sw.js`);
    const stored = await cacheContents(page);
    const names = Object.keys(stored);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^email-to-pdf-offline-[0-9a-f]{20}$/);
    expect(stored[names[0] ?? '']).toEqual(paths);
    // Online, the service worker made only GETs of the site itself: its own
    // script and the listed files, nothing else. Chromium lists them all, so
    // there the set must be exactly that; Firefox and WebKit do not tie
    // requests to the service worker, so there the list is empty.
    const fromWorker = requestObjects.filter((request) => request.serviceWorker() !== null);
    for (const request of fromWorker)
    {
        expect(request.method(), request.url()).toBe('GET');
        expect(new URL(request.url()).origin, request.url()).toBe(origin);
        expect(new URL(request.url()).search, request.url()).toBe('');
    }
    const workerPaths = [...new Set(fromWorker.map((request) => new URL(request.url()).pathname))].sort();
    expect(workerPaths).toEqual(engineOf(context) === 'chromium' ? [...paths, '/sw.js'].sort() : []);

    // 2. Offline: reload. The page and all its files come from the stored copy.
    await goOffline(context);
    const reloadedAt = requestObjects.length;
    const response = await page.reload({ waitUntil: 'load' });
    expect(response?.fromServiceWorker()).toBe(true);
    expect(response?.status()).toBe(200);
    // The stored page keeps its security headers and its <meta> CSP.
    const headers = response?.headers() ?? {};
    expect(headers['content-security-policy']).toBe(cspForHeader());
    expect(headers['referrer-policy']).toBe(REFERRER_POLICY);
    expect(headers['permissions-policy']).toBe(PERMISSIONS_POLICY);
    await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', cspForMeta());
    await expect(page.locator('#drop-zone')).toBeVisible();
    await expect(page.getByRole('banner')).toContainText(en.app.promise);
    await expect(page.locator('html')).toHaveAttribute('data-pdf-fonts', 'ready');
    expect(await waitForControl(page)).toBe(`${origin}/sw.js`);

    // 3. Still offline: the whole tool works.
    await addFiles(page);
    const next = page.waitForEvent('download');
    await page.getByRole('button', { name: en.actions.makePdf }).click();
    const download = await next;
    const bytes = new Uint8Array(readFileSync(await download.path()));
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');

    // Nothing after the reload reached the network: every request was a blob:
    // read or answered by the service worker, and none failed.
    const afterReload = requestObjects.slice(reloadedAt).filter((request) => !isBlob(request));
    expect(afterReload.length).toBeGreaterThan(0);
    for (const request of afterReload)
    {
        const answer = await request.response();
        expect(answer?.fromServiceWorker(), request.url()).toBe(true);
        expect(request.failure(), request.url()).toBeNull();
        expect(paths, request.url()).toContain(new URL(request.url()).pathname);
    }
    await expectCleanRun(page, 2);

    // 4. Nothing was stored at run time: the copy is exactly the list, still.
    expect(await cacheContents(page)).toEqual(stored);
    const storage = await page.evaluate(async () => ({
        localStorage: localStorage.length,
        sessionStorage: sessionStorage.length,
        indexedDB: (await indexedDB.databases()).length,
        cookie: document.cookie,
    }));
    expect(storage).toEqual({ localStorage: 0, sessionStorage: 0, indexedDB: 0, cookie: '' });

    // 5. Offline controls, each in a new tab of the same browser (a failed
    // navigation leaves its tab on the browser's error page): a "?..."
    // variant and an unlisted address are left to the network, which is off,
    // so they fail; a listed file opens from the copy. Still nothing stored.
    for (const path of ['/?from=test', '/index.html', '/THIRD_PARTY_NOTICES.txt?x=1'])
    {
        const tab = await context.newPage();
        await expect(tab.goto(path), path).rejects.toThrow();
        await tab.close();
    }
    const tab = await context.newPage();
    const notices = await tab.goto('/THIRD_PARTY_NOTICES.txt');
    expect(notices?.fromServiceWorker()).toBe(true);
    expect(await cacheContents(tab)).toEqual(stored);
    await tab.close();
    await goOnline(context);
});

test('/sw.js has its own CSP (only connect-src differs), every other file keeps the page CSP', async ({ page }) =>
{
    // The headers as the server sends them (no browser involved).
    const sw = await page.request.get('/sw.js');
    expect(sw.status()).toBe(200);
    expect(sw.headers()['content-type']).toMatch(/javascript/);
    expect(sw.headers()['content-security-policy']).toBe(cspForServiceWorker());
    expect(sw.headers()['referrer-policy']).toBe(REFERRER_POLICY);
    expect(sw.headers()['permissions-policy']).toBe(PERMISSIONS_POLICY);
    for (const path of ['/', '/index.html', '/THIRD_PARTY_NOTICES.txt', '/sw.js.map', '/assets/sw.js'])
    {
        expect((await page.request.get(path)).headers()['content-security-policy'], path).toBe(cspForHeader());
    }
    // The list written into sw.js is exactly the built files.
    const listed = /"(\{\\"version\\":.*?\})"/.exec(await sw.text())?.[1] ?? '';
    const manifest = JSON.parse(JSON.parse(`"${listed}"`) as string) as { version: string; paths: string[] };
    expect(manifest.paths).toEqual(expectedPaths());
    expect(manifest.version).toMatch(/^[0-9a-f]{20}$/);
});

test("inside the service worker, its CSP blocks other sites and allows the site's own files", async ({ context, page, browserName }) =>
{
    test.skip(browserName !== 'chromium', 'Playwright gives access to a service worker in Chromium only (context.serviceWorkers())');
    await page.goto('/', { waitUntil: 'load' });
    await waitForControl(page);
    const [worker] = context.serviceWorkers();
    expect(worker?.url()).toBe(`${origin}/sw.js`);
    const result = await worker?.evaluate(async () =>
    {
        const reports: string[] = [];
        self.addEventListener('securitypolicyviolation', (event) => reports.push(`${event.effectiveDirective} ${event.blockedURI}`));
        const attempt = (url: string): Promise<string> =>
            fetch(url, { cache: 'no-store' }).then(
                (r) => `resolved ${String(r.status)}`,
                () => 'rejected',
            );
        const outside = await attempt('https://example.invalid/x');
        const own = await attempt('/THIRD_PARTY_NOTICES.txt');
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { outside, own, reports };
    });
    expect(result).toEqual({ outside: 'rejected', own: 'resolved 200', reports: ['connect-src https://example.invalid/x'] });
    // Blocked by the CSP before it became a request: the safety net never saw it.
    expect(watch.requests.filter((url) => url.includes('example.invalid'))).toEqual([]);
});

test('online, the service worker answers only listed files: an unlisted or "?..." address goes to the site as usual', async ({ context, page, browserName }) =>
{
    test.skip(browserName !== 'chromium', 'Checked in Chromium, where Playwright ties requests to a service worker reliably');
    await page.goto('/', { waitUntil: 'load' });
    await expect(page.locator('#drop-zone')).toBeVisible();
    expect(await waitForControl(page)).toBe(`${origin}/sw.js`);
    // Each in a new tab of the same browser, so the service worker is asked.
    const open = async (path: string): Promise<{ fromServiceWorker: boolean; status: number }> =>
    {
        const tab = await context.newPage();
        const response = await tab.goto(path, { waitUntil: 'load' });
        await tab.close();
        return { fromServiceWorker: response?.fromServiceWorker() ?? true, status: response?.status() ?? 0 };
    };
    // Left alone (no respondWith): the site itself answers them.
    for (const path of ['/index.html', '/?x=1', '/THIRD_PARTY_NOTICES.txt?x=1'])
    {
        expect(await open(path), path).toEqual({ fromServiceWorker: false, status: 200 });
    }
    // Positive control: a listed file, online too, is answered from the copy.
    expect(await open('/THIRD_PARTY_NOTICES.txt')).toEqual({ fromServiceWorker: true, status: 200 });
    await expectCleanRun(page, 1);
});

/**
 * Test-only: the browser refuses every registration (register() rejects),
 * and the real register() is kept as window.__e2eRegister so the test can
 * register later, when it chooses.
 */
async function refuseRegistrations(page: Page): Promise<void>
{
    await page.addInitScript(() =>
    {
        const real = ServiceWorkerContainer.prototype.register.bind(navigator.serviceWorker);
        (window as unknown as { __e2eRegister: (url: string) => Promise<unknown> }).__e2eRegister = (url) =>
            real(url, { scope: '/', updateViaCache: 'none' });
        ServiceWorkerContainer.prototype.register = () => Promise.reject(new TypeError('refused by the test'));
    });
}

const registrations = (page: Page): Promise<number> => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);

test('a refused registration is calm: no error, no service worker, the tool works', async ({ page }) =>
{
    await refuseRegistrations(page);
    await page.goto('/', { waitUntil: 'load' });
    await expect(page.locator('#drop-zone')).toBeVisible();
    await page.waitForTimeout(1000);
    expect(await registrations(page)).toBe(0);
    expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
    await addFiles(page);
    expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(0);
    await expectCleanRun(page, 1);
});

test('a missing sw.js is calm: only the browser notes the 404, the tool works', async ({ context, page, browserName }) =>
{
    // Seen in Firefox: no request of Firefox's for a service worker script ever
    // reaches Playwright's routes (the real sw.js is fetched and installed), so
    // a 404 cannot be served to it. The refused registration above covers
    // Firefox.
    test.skip(browserName === 'firefox', "Playwright's routes do not see Firefox's fetch of a service worker script");
    await context.route(`${origin}/sw.js`, (route) => route.fulfill({ status: 404, body: '' }));
    await page.goto('/', { waitUntil: 'load' });
    await expect(page.locator('#drop-zone')).toBeVisible();
    await page.waitForTimeout(1000);
    expect(await registrations(page)).toBe(0);
    await addFiles(page);
    // The browser's own line about the 404 (not the app's: it catches the
    // refusal and logs nothing). Exactly one, then nothing else.
    const own =
        browserName === 'chromium'
            ? 'console: A bad HTTP response code (404) was received when fetching the script.'
            : 'console: Failed to load resource: the server responded with a status of 404 (Not Found)';
    expect(problems.filter((line) => line === own)).toHaveLength(1);
    problems = problems.filter((line) => line !== own);
    await expectCleanRun(page, 1);
});

test('a new version deletes only the older caches of this service worker, never another cache', async ({ page }) =>
{
    await refuseRegistrations(page);
    await page.goto('/', { waitUntil: 'load' });
    await expect(page.locator('#drop-zone')).toBeVisible();
    // Plant an "older version" of our cache, and a cache that is not ours.
    const OLD = 'email-to-pdf-offline-00000000000000000000';
    const FOREIGN = 'another-cache';
    await page.evaluate(async (names) =>
    {
        for (const name of names)
        {
            await caches.open(name);
        }
    }, [OLD, FOREIGN]);
    // Register now, as a later visit would.
    await page.evaluate(async () =>
    {
        await (window as unknown as { __e2eRegister: (url: string) => Promise<unknown> }).__e2eRegister('/sw.js');
    });
    expect(await waitForControl(page)).toBe(`${origin}/sw.js`);
    const contents = await cacheContents(page);
    const names = Object.keys(contents).sort();
    expect(names).toHaveLength(2);
    expect(names).toContain(FOREIGN);
    expect(names).not.toContain(OLD);
    const current = names.find((name) => name !== FOREIGN) ?? '';
    expect(current).toMatch(/^email-to-pdf-offline-[0-9a-f]{20}$/);
    expect(contents[current]).toEqual(expectedPaths());
    expect(contents[FOREIGN]).toEqual([]);
    await expectCleanRun(page, 1);
});
