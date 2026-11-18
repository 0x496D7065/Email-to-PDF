// Browser test of the "no network" guarantee and the Content Security Policy
// (README.md, rules R1, R2 and R3). Runs against the built site served by
// `vite preview` (see playwright.config.ts).
//
// Only reserved `.invalid` domains are used: they can never resolve to a real
// server. On top of that, a safety net aborts any request that leaves the
// local preview server, so even a broken CSP could not reach the internet.
import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';
import { cspForHeader, cspForMeta, PERMISSIONS_POLICY, REFERRER_POLICY } from '../../../Source/security-headers/headers.ts';
import { DONATION_IMAGE, DONATION_URL } from '../../../Source/web-page/safe-dom.ts';
import { en } from '../../../Source/web-page/translations/en.ts';

/** What we keep from each `securitypolicyviolation` event. */
interface Violation
{
    directive: string;
    blockedURI: string;
    /** The policy that was violated: tells the header CSP and the meta CSP apart. */
    policy: string;
    /** Fired at a <select>: WebKit's report about its own <select> parts (see withoutSelectReports in Helper/Test/browser-tests/support/network-and-csp-watch.ts). */
    select: boolean;
}

declare global
{
    interface Window
    {
        __cspViolations: Violation[];
        /** Set by the inline script of tryForbiddenThings if it ever ran: must stay unset. */
        __cspInlineRan?: boolean;
    }
}

/**
 * Request types that mean "the page talked to a server on its own".
 * WebSockets are not in this list: Playwright does not report them as
 * requests, so they are recorded separately by `routeWebSocket` (see
 * watchNetwork).
 */
const FORBIDDEN_TYPES = ['fetch', 'xhr', 'eventsource', 'ping'];

// Shared per-test state, reset in beforeEach. This assumes the tests in this
// file never run in parallel within one worker (true with the current config:
// Playwright runs the tests of a file one after another unless
// `fullyParallel` or `test.describe.configure({ mode: 'parallel' })` is set).
let origin = '';
let requests: Request[] = [];
let websockets: string[] = [];

/**
 * Records every request of the context (pages and their workers) and aborts
 * any request that is not to the local preview server (safety net).
 * WebSockets never reach `context.on('request')` or `context.route`; the
 * `routeWebSocket` handler both records and closes them (the app has no
 * reason to open one), so test (a) sees any attempt. Recording must happen
 * here: once routed, Playwright substitutes the page's WebSocket, so it may
 * produce neither a `page.on('websocket')` event nor a CSP violation.
 * WebSockets opened inside workers are not covered by routeWebSocket (and
 * their CSP violations fire inside the worker): the parse and engine workers
 * are checked by Helper/Test/browser-tests/parse-files.spec.ts, with detectors that do see worker
 * activity.
 */
async function watchNetwork(context: BrowserContext): Promise<void>
{
    context.on('request', (request) => requests.push(request));
    await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'),
    );
    await context.routeWebSocket(/.*/, async (ws) =>
    {
        websockets.push(ws.url());
        await ws.close();
    });
}

/** CSP violations collected in the page since it loaded. */
function violations(page: Page): Promise<Violation[]>
{
    return page.evaluate(() => window.__cspViolations);
}

test.beforeEach(async ({ context, page, baseURL }) =>
{
    origin = new URL(baseURL ?? '').origin;
    requests = [];
    websockets = [];
    await watchNetwork(context);
    // Runs in the page before any of the app's scripts: stores each CSP
    // violation on `window` so the test can read them back.
    await page.addInitScript(() =>
    {
        window.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', (event) =>
        {
            window.__cspViolations.push({
                directive: event.effectiveDirective,
                blockedURI: event.blockedURI,
                policy: event.originalPolicy,
                select: event.target instanceof HTMLSelectElement,
            });
        });
    });
});

/**
 * The violations without WebKit's <select> reports, after checking there is
 * exactly one per policy in force (`policies`) in WebKit and none elsewhere
 * (see withoutSelectReports in Helper/Test/browser-tests/support/network-and-csp-watch.ts).
 */
function withoutSelect(browserName: string, list: readonly Violation[], policies: string[]): Omit<Violation, 'select'>[]
{
    const quirk = list.filter((v) => v.select).map((v) => `${v.directive} ${v.blockedURI} | ${v.policy}`);
    expect(quirk.sort()).toEqual(browserName === 'webkit' ? policies.map((policy) => `style-src-attr inline | ${policy}`).sort() : []);
    return list.filter((v) => !v.select).map(({ directive, blockedURI, policy }) => ({ directive, blockedURI, policy }));
}

test('loads with zero requests outside its own origin', async ({ page }) =>
{
    // "networkidle" = no request for 500 ms, i.e. the app has settled.
    await page.goto('/', { waitUntil: 'networkidle' });

    const urls = requests.map((request) => request.url());
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls)
    {
        expect(new URL(url).origin, url).toBe(origin);
    }

    const talking = requests.filter((request) => FORBIDDEN_TYPES.includes(request.resourceType()));
    expect(talking.map((request) => `${request.resourceType()} ${request.url()}`)).toEqual([]);
    expect(websockets).toEqual([]);
});

test('loads with zero CSP violations', async ({ page, browserName }) =>
{
    await page.goto('/', { waitUntil: 'networkidle' });
    expect(withoutSelect(browserName, await violations(page), [cspForHeader(), cspForMeta()])).toEqual([]);
});

test('sends the security headers and the meta CSP', async ({ page }) =>
{
    const response = await page.goto('/');
    expect(response).not.toBeNull();
    const headers = response?.headers() ?? {};
    expect(headers['content-security-policy']).toBe(cspForHeader());
    expect(headers['referrer-policy']).toBe(REFERRER_POLICY);
    expect(headers['permissions-policy']).toBe(PERMISSIONS_POLICY);

    const meta = page.locator('meta[http-equiv="Content-Security-Policy"]');
    await expect(meta).toHaveAttribute('content', cspForMeta());
});

test('shows the app shell with its privacy promise', async ({ page }) =>
{
    await page.goto('/');
    await expect(page.getByRole('banner')).toContainText(en.app.promise);
});

/** Does forbidden things inside the page: an inline script, a fetch() and a remote image. */
async function tryForbiddenThings(page: Page): Promise<void>
{
    // An inline <script> put into the page must not run.
    const ran = await page.evaluate(() =>
    {
        const script = document.createElement('script');
        script.textContent = 'window.__cspInlineRan = true;';
        document.body.append(script);
        return window.__cspInlineRan === true;
    });
    expect(ran).toBe(false);

    const fetchResult = await page.evaluate(async () =>
    {
        try
        {
            await fetch('https://example.invalid/x');
            return 'resolved';
        }
        catch
        {
            return 'rejected';
        }
    });
    expect(fetchResult).toBe('rejected');

    await page.evaluate(() =>
    {
        const img = document.createElement('img');
        img.src = 'https://example.invalid/p.png';
        document.body.append(img);
    });
}

/** Violations as sorted "directive blockedURI | policy" strings (`policies`: those in force, see withoutSelect). */
async function violationKeys(page: Page, browserName: string, policies: string[]): Promise<string[]>
{
    return withoutSelect(browserName, await violations(page), policies)
        .map((v) => `${v.directive} ${v.blockedURI} | ${v.policy}`)
        .sort();
}

/**
 * Checks that it was the CSP that stopped the image, not the safety net:
 * Chromium reports the blocked image as a request that failed with reason
 * "csp" (a request aborted by the safety net would show a different reason).
 * Firefox and WebKit stop it before it becomes a request at all, so the
 * safety net never saw it (the violation reports, checked before, show the
 * CSP did). The blocked fetch never even becomes a request.
 */
async function expectImageBlockedByCsp(browserName: string): Promise<void>
{
    // Polled in Chromium, where the failed request shows up; elsewhere the list
    // must stay empty, checked once the reports above have arrived.
    const outside = (): string[] =>
        requests
            .filter((request) => new URL(request.url()).origin !== origin)
            .map((request) => `${request.url()} ${request.failure()?.errorText ?? 'not failed'}`);
    if (browserName === 'chromium')
    {
        await expect.poll(outside).toEqual(['https://example.invalid/p.png csp']);
    }
    else
    {
        expect(outside()).toEqual([]);
    }
}

// Positive control: proves the CSP is really enforced, by deliberately doing
// forbidden things inside the page and checking the browser blocks them
// (in each of the three browsers the suite runs in).
// Both policies (header and meta) must report each violation on their own,
// so a silently ignored copy would make this test fail.
test('the CSP blocks fetch() and remote images (header and meta)', async ({ page, browserName }) =>
{
    await page.goto('/', { waitUntil: 'networkidle' });
    await tryForbiddenThings(page);

    // Violation events arrive asynchronously, so poll until all are recorded.
    const policies = [cspForHeader(), cspForMeta()];
    const expected = [];
    for (const policy of policies)
    {
        expected.push(`script-src-elem inline | ${policy}`);
        expected.push(`connect-src https://example.invalid/x | ${policy}`);
        expected.push(`img-src https://example.invalid/p.png | ${policy}`);
    }
    await expect.poll(() => violationKeys(page, browserName, policies)).toEqual(expected.sort());

    await expectImageBlockedByCsp(browserName);
});

// Hosts that cannot send headers (e.g. GitHub Pages) rely on the meta tag
// alone. Serve the same page WITHOUT the CSP header and check the meta tag
// still blocks everything on its own. The safety net stays active.
test('the meta CSP alone blocks fetch() and remote images', async ({ page, browserName }) =>
{
    await page.route(
        (url) => url.origin === origin && url.pathname === '/',
        async (route) =>
        {
            const response = await route.fetch();
            const headers = { ...response.headers() };
            delete headers['content-security-policy'];
            await route.fulfill({ response, headers, body: await response.text() });
        },
    );

    const response = await page.goto('/', { waitUntil: 'networkidle' });
    expect(response?.headers()['content-security-policy']).toBeUndefined();
    // The bundled Ko-fi image loads under the meta CSP alone too (img-src 'self').
    expect(await page.locator('#donate-link img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    const policy = cspForMeta();
    expect(withoutSelect(browserName, await violations(page), [policy])).toEqual([]);

    await tryForbiddenThings(page);

    await expect
        .poll(() => violationKeys(page, browserName, [policy]))
        .toEqual(
            [
                `script-src-elem inline | ${policy}`,
                `connect-src https://example.invalid/x | ${policy}`,
                `img-src https://example.invalid/p.png | ${policy}`,
            ].sort(),
        );

    await expectImageBlockedByCsp(browserName);
});

// The Ko-fi donation button (Source/web-page/safe-dom.ts, donationLink): the one link to
// another website (README.md, rule R1). It must be a plain link that loads
// nothing from Ko-fi, with Ko-fi's image served by this site.
test('the Ko-fi button is a plain link with its image from this site, and Ko-fi is never contacted', async ({ page, browserName }) =>
{
    await page.goto('/', { waitUntil: 'networkidle' });
    const link = page.locator('#donate-link');
    await expect(link).toHaveAttribute('href', DONATION_URL);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveAccessibleName(en.donate.label);
    // The only link of the page; nothing else on it mentions Ko-fi's site, and no
    // <link> could warm up a connection or fetch the page ahead of a click.
    await expect(page.locator('a[href]')).toHaveCount(1);
    await expect(page.locator('link[rel~="prefetch"], link[rel~="preconnect"], link[rel~="dns-prefetch"], link[rel~="prerender"]')).toHaveCount(0);
    await expect(page.locator('script[type="speculationrules"], iframe, object, embed')).toHaveCount(0);
    const host = new URL(DONATION_URL).host;
    expect(await page.evaluate((h) => document.documentElement.outerHTML.split(h).length - 1, host)).toBe(1);

    // The image: this site's bundled file, loaded (no broken image), shown
    // about 36 px high with its own shape (980 x 198 pixels).
    const image = link.locator('img');
    const shown = await image.evaluate((img: HTMLImageElement) => ({
        src: img.currentSrc,
        loaded: img.complete,
        natural: [img.naturalWidth, img.naturalHeight],
        box: [img.getBoundingClientRect().width, img.getBoundingClientRect().height],
    }));
    expect(shown.src).toBe(`${origin}/${DONATION_IMAGE.src}`);
    expect(shown.loaded).toBe(true);
    expect(shown.natural).toEqual([980, 198]);
    expect(shown.box[1]).toBeCloseTo(36, 0);
    expect(Math.abs((shown.box[0] ?? 0) - (36 * 980) / 198)).toBeLessThan(1);
    const served = requests.find((request) => request.url() === shown.src && request.frame() === page.mainFrame());
    expect(served, 'the image request').toBeDefined();
    const response = await served?.response();
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-type']).toBe('image/png');

    // Pointing at it and focusing it fetches nothing either (no prefetch on hover).
    const before = requests.length;
    await link.hover();
    await link.focus();
    await page.waitForTimeout(500);
    expect(requests.slice(before).map((request) => request.url())).toEqual([]);
    for (const request of requests)
    {
        expect(new URL(request.url()).origin, request.url()).toBe(origin);
    }
    expect(websockets).toEqual([]);
    expect(withoutSelect(browserName, await violations(page), [cspForHeader(), cspForMeta()])).toEqual([]);
});

// What a click does: a new tab goes to Ko-fi (here stopped by the safety net
// before it leaves the computer), with no referrer; this tab stays where it
// is, with the emails added still there.
test('a click on the Ko-fi button opens a new tab, sends no referrer, and keeps this tab and its emails', async ({ page, context }) =>
{
    await page.goto('/', { waitUntil: 'networkidle' });
    const url = page.url();
    const fixture = decodeURIComponent(new URL('../test-data/eml/10-order-1-alice.eml', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
    await page.locator('#file-input').setInputFiles(fixture);
    const items = page.locator('#preview-list > li');
    await expect(items).toHaveCount(1, { timeout: 60_000 });

    const opened = context.waitForEvent('page');
    await page.locator('#donate-link').click();
    const tab = await opened;
    expect(tab).not.toBe(page);
    // The new tab's one request: the donation page, with no Referer header.
    await expect.poll(() => requests.filter((request) => request.url() === DONATION_URL).length).toBe(1);
    const visit = requests.find((request) => request.url() === DONATION_URL);
    expect(visit?.frame().page()).toBe(tab);
    expect(visit?.isNavigationRequest()).toBe(true);
    expect(visit?.headers()['referer']).toBeUndefined();
    await tab.close();

    // This tab did not move, and nothing of the user's work was lost.
    expect(page.url()).toBe(url);
    await expect(items).toHaveCount(1);
    // Every other request stayed on this site.
    for (const request of requests.filter((r) => r.url() !== DONATION_URL))
    {
        expect(new URL(request.url()).origin, request.url()).toBe(origin);
    }
});
