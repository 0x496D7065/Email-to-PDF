// Browser test of the inert HTML-to-text path (README.md, rules R1, R2, R4):
// the real DOMParser-based converter runs in Chromium, Firefox and WebKit,
// inside the built site served by `vite preview` (see playwright.config.ts).
//
// How the code gets into the page without shipping a test hook:
// the converter is not wired into the page yet, so the built site does not
// contain it. beforeAll bundles Helper/Test/browser-tests/support/html-to-text-test-entry.ts IN MEMORY
// (`write: false`) with the project's own vite.config.ts, and a Playwright
// route serves that bundle at /__e2e__/... on the site's own origin. The page
// then loads it with a dynamic import() inside page.evaluate. Nothing is
// written to dist/, nothing is added to the production bundle, and the CSP is
// unchanged (a same-origin module script is allowed by `script-src 'self'`).
//
// Each conversion test checks that hostile HTML:
// - gives the expected text, without script code, handlers or remote URLs;
// - runs no script: no flag pushed by a <script> or an inline handler, no
//   dialog, the page title and address unchanged;
// - loads nothing: no request other than the test bundle, no WebSocket.
// The checks run twice: with the site's real CSP, and with ALL CSP removed.
// The second run proves that DOMParser itself is inert, not only that the CSP
// blocked something. Positive controls prove the detectors notice a leak.
//
// Chromium note: DOMParser documents are checked against the page's CSP while
// they are parsed. An inline event handler attribute, a <style> block or a
// <base> element in the email HTML is REPORTED as a CSP violation
// ('script-src-attr', 'style-src-elem', 'base-uri'), and so is the `src` of
// a <track> element ('media-src'), although nothing runs and nothing is
// loaded: these are checks, not attempts. Like 'script-src-attr', a
// 'media-src' report alone cannot prove inertness (see below). Such reports
// stay in the browser (the CSP has no report-uri). Each report is recorded
// as "directive blockedURI parse|live": "parse" when it is fired at the
// document itself, "live" when fired at an element. An inline report
// (blockedURI "inline") made while parsing is fired at the document (the
// parsed element is in no live page); a blocked inline handler or style in
// the LIVE page is fired at its element. A blocked LOAD is fired at the
// document wherever the element is (see the first positive control), so for
// URL reports the label proves nothing. Under the CSP, only these parse-time
// reports are tolerated: inline reports labelled "parse" for the directives
// above, and the <base> and <track> reports for their one URL each.
// Anything else (any "live" report, img-src, connect-src, script-src-elem,
// frame-src, ...) would mean a load or an execution was attempted, and fails
// the test. Firefox and WebKit make none of these parse-time reports, so
// there nothing at all is tolerated (untoleratedReports in
// Helper/Test/browser-tests/support/network-and-csp-watch.ts).
//
// Why BOTH runs must stay: the with-CSP run tells a parse-time check apart
// from a blocked attempt in the live page only by where the report is fired
// (the document, or a live element), which is how Chromium behaves today, not
// a guarantee. Only the without-CSP run, where nothing would block
// such an attempt, proves that nothing is ever attempted: there, any handler
// that ran would push a flag, and any track load would show up as a request,
// and fail the test (see the positive controls at the end of this file).
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { build, type Rolldown } from 'vite';
import { FIXTURES } from '../test-data/manifest.ts';
import type * as Entry from './support/html-to-text-test-entry.ts';
import {
    browserEngineOf,
    isWebKitBlobRead,
    parseTimeReportFilter,
    untoleratedReports,
    withoutSelectReports,
    type ExactParseTimeReport,
} from './support/network-and-csp-watch.ts';

declare global
{
    interface Window
    {
        /** "directive blockedURI parse|live" of each CSP violation (separate from no-network.spec.ts's list). */
        __e2eViolations: string[];
        /** Pushed to by code in the hostile HTML: must stay empty. */
        __e2eFlags: string[];
    }
}

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('../../..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const BUNDLE_PATH = '/__e2e__/';

/**
 * Single parse-time reports tolerated as exact "directive URL parse" strings,
 * never as a whole directive. Chromium checks the `href` of a <base> element
 * against base-uri and the `src` of a <track> element against media-src as
 * soon as the element is parsed, then neither uses the base nor loads the
 * track (the DOMParser document has no browsing context). The without-CSP
 * run proves no request for the track is ever made.
 */
const PARSE_TIME_REPORTS: ReadonlySet<ExactParseTimeReport> = new Set([
    'base-uri https://base.invalid/ parse',
    'media-src https://track.invalid/t.vtt parse',
] as const);

/**
 * True for a recorded report ("directive blockedURI parse|live") that
 * DOMParser makes while parsing (see the header): the shared inline
 * parse-time reports (Helper/Test/browser-tests/support/network-and-csp-watch.ts), and the two above exactly.
 */
const isParseTimeReport = parseTimeReportFilter(PARSE_TIME_REPORTS);

/** The in-memory test bundle: file name -> code. */
const bundle = new Map<string, string>();
let entryFile = '';

test.beforeAll(async () =>
{
    test.setTimeout(120_000);
    const output = await build({
        root: ROOT,
        configFile: `${ROOT}vite.config.ts`,
        mode: 'production',
        logLevel: 'warn',
        build: {
            write: false, // in memory only: dist/ is never touched
            emptyOutDir: false,
            copyPublicDir: false,
            lib: { entry: `${ROOT}Helper/Test/browser-tests/support/html-to-text-test-entry.ts`, formats: ['es'],
                fileName: 'html-to-text-test-entry' },
        },
    });
    const outputs = (Array.isArray(output) ? output : [output]) as Rolldown.RolldownOutput[];
    for (const item of outputs.flatMap((o) => o.output))
    {
        if (item.type !== 'chunk')
        {
            continue;
        }
        bundle.set(item.fileName, item.code);
        if (item.isEntry)
        {
            entryFile = item.fileName;
        }
    }
    expect(entryFile).not.toBe('');
});

let origin = '';
let requestUrls: string[] = [];
/** requestUrls.length once the page had loaded. */
let loadedAt = 0;
let websockets: string[] = [];
let dialogs: string[] = [];

/** Records every request (WebKit's in-memory blob reads aside, see isWebKitBlobRead); aborts anything that leaves the preview server (safety net). */
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

/** Serves the in-memory test bundle on the site's own origin. */
async function serveBundle(page: Page): Promise<void>
{
    await page.route(`**${BUNDLE_PATH}*`, async (route) =>
    {
        const name = new URL(route.request().url()).pathname.slice(BUNDLE_PATH.length);
        const code = bundle.get(name);
        await (code === undefined ? route.fulfill({ status: 404 }) : route.fulfill({ body: code, contentType: 'text/javascript' }));
    });
}

/** Serves the page with NO CSP at all: header removed and <meta> CSP tag removed. */
async function removeCsp(page: Page): Promise<void>
{
    await page.route(
        (url) => url.origin === origin && url.pathname === '/',
        async (route) =>
        {
            const response = await route.fetch();
            const headers = { ...response.headers() };
            delete headers['content-security-policy'];
            const body = (await response.text()).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
            if (body.includes('Content-Security-Policy'))
            {
                throw new Error('meta CSP not removed');
            }
            await route.fulfill({ response, headers, body });
        },
    );
}

test.beforeEach(async ({ context, page, baseURL }) =>
{
    origin = new URL(baseURL ?? '').origin;
    requestUrls = [];
    loadedAt = 0;
    websockets = [];
    dialogs = [];
    await watchNetwork(context);
    await serveBundle(page);
    page.on('dialog', (dialog) =>
    {
        dialogs.push(dialog.message());
        void dialog.dismiss();
    });
    await page.addInitScript(() =>
    {
        window.__e2eViolations = [];
        window.__e2eFlags = [];
        // An inline report made while DOMParser parses is fired at the document;
        // an inline one about the live page at the element concerned (see the header).
        document.addEventListener('securitypolicyviolation', (event) =>
        {
            // "select": WebKit's report about a <select> (see withoutSelectReports).
            const where = event.target === document ? 'parse' : event.target instanceof HTMLSelectElement ? 'select' : 'live';
            window.__e2eViolations.push(`${event.effectiveDirective} ${event.blockedURI} ${where}`);
        });
    });
});

/** How many CSPs the page was opened with (header and <meta>: 2; none: 0). */
let cspPolicies = 2;

/** Opens the site, with or without its CSP, and notes where its own requests end. */
async function open(page: Page, csp: 'with-csp' | 'without-csp'): Promise<void>
{
    if (csp === 'without-csp')
    {
        await removeCsp(page);
    }
    cspPolicies = csp === 'with-csp' ? 2 : 0;
    await page.goto('/', { waitUntil: 'networkidle' });
    loadedAt = requestUrls.length;
    if (csp === 'without-csp')
    {
        expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').count()).toBe(0);
    }
}

/** Requests made since the page loaded, except the test bundle itself. */
function requestsAfterLoad(): string[]
{
    return requestUrls.slice(loadedAt).filter((url) => !(new URL(url).origin === origin && new URL(url).pathname.startsWith(BUNDLE_PATH)));
}

/**
 * Asserts nothing ran and nothing was loaded. Waits a moment first, so that
 * an image load or an event handler would have had time to happen.
 */
async function expectNothingHappened(page: Page): Promise<void>
{
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => window.__e2eFlags)).toEqual([]);
    expect(dialogs).toEqual([]);
    expect(await page.title()).toBe('Email to PDF');
    expect(page.url()).toBe(`${origin}/`);
    expect(requestsAfterLoad()).toEqual([]);
    expect(websockets).toEqual([]);
    const browserName = browserEngineOf(page.context());
    const violations = withoutSelectReports(browserName, await page.evaluate(() => window.__e2eViolations), cspPolicies);
    expect(untoleratedReports(browserName, violations, isParseTimeReport)).toEqual([]);
}

/** Converts `html` in the page with the production DOMParser converter (default limits unless given). */
function convertInPage(page: Page, html: string, limits?: Entry.HtmlToTextLimits): Promise<Entry.HtmlToTextResult>
{
    return page.evaluate(
        async ({ url, html, limits }) =>
        {
            const entry = (await import(url)) as typeof Entry;
            return entry.htmlToTextWithDomParser(html, limits);
        },
        { url: `${BUNDLE_PATH}${entryFile}`, html, limits },
    );
}

/**
 * Hostile synthetic HTML: every way we know of to run code or load something,
 * plus fallback content (noscript, object, video, audio, svg <text>) whose
 * text must be KEPT. All hosts are reserved `.invalid` names.
 */
const HOSTILE_HTML = `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval'; img-src *">
<meta http-equiv="refresh" content="0;url=https://nav.invalid/">
<base href="https://base.invalid/">
<link rel="stylesheet" href="https://cdn.invalid/s.css">
<link rel="preload" as="image" href="https://preload.invalid/p.png">
<link rel="dns-prefetch" href="https://dns-prefetch.invalid/">
<link rel="prefetch" href="https://prefetch.invalid/p.html">
<link rel="modulepreload" href="https://modulepreload.invalid/m.js">
<link rel="icon" href="https://icon.invalid/favicon.ico">
<style>@import url('https://css.invalid/i.css');
@font-face { font-family: RemoteFont; src: url('https://font.invalid/f.woff2'); }
body { background: url('https://bg.invalid/b.png'); font-family: RemoteFont; }</style>
<script>window.__e2eFlags.push('script');</script>
<script src="https://script.invalid/s.js"></script>
</head>
<body onload="window.__e2eFlags.push('body-onload')" background="https://bg.invalid/attr.png">
<p style="background-image: url('https://bg.invalid/inline.png')">Visible text</p>
<img src="https://tracker.invalid/p.png" width="1" height="1" alt="">
<img src="missing.png" onerror="window.__e2eFlags.push('img-onerror')">
<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" onload="window.__e2eFlags.push('img-onload')" alt="pixel">
<img srcset="https://srcset.invalid/a.png 1x, https://srcset.invalid/b.png 2x" alt="">
<picture><source srcset="https://picture.invalid/p.webp" type="image/webp"><img src="https://picture.invalid/p.png" alt="Picture alt"></picture>
<iframe src="https://frame.invalid/" onload="window.__e2eFlags.push('iframe-onload')"></iframe>
<iframe srcdoc="<script>parent.__e2eFlags.push('srcdoc')</script>"></iframe>
<object data="https://object.invalid/o.bin">Object fallback</object>
<video poster="https://poster.invalid/p.png" src="https://video.invalid/v.mp4"></video>
<video controls><source src="https://video.invalid/s.mp4" type="video/mp4"><track src="https://track.invalid/t.vtt" kind="captions" default>Video fallback</video>
<audio autoplay src="https://audio.invalid/a.mp3" onplay="window.__e2eFlags.push('audio-onplay')">Audio fallback</audio>
<svg onload="window.__e2eFlags.push('svg-onload')"><image href="https://svg.invalid/i.png"></image><script>window.__e2eFlags.push('svg-script')</script><text x="0" y="10">SVG text</text></svg>
<noscript><p>Noscript fallback</p></noscript>
<marquee onstart="window.__e2eFlags.push('marquee-onstart')">Marquee text</marquee>
<table background="https://bg.invalid/table.png"><tr><td background="https://bg.invalid/td.png">Cell one</td><td>Cell two</td></tr></table>
<input autofocus onfocus="window.__e2eFlags.push('autofocus')">
<input type="image" src="https://input.invalid/i.png" alt="Image button" onerror="window.__e2eFlags.push('input-image-onerror')">
<details open ontoggle="window.__e2eFlags.push('toggle')"><summary>Sum</summary>Details</details>
<a href="javascript:window.__e2eFlags.push('js-link')">Link text</a>
<form action="https://form.invalid/submit"><button>Send</button> <input type="submit" value="Submit form"></form>
</body></html>`;

/** Visible and fallback text kept; script code, handlers, URLs and the email's own CSP never appear. */
const HOSTILE_TEXT = [
    'Visible text',
    '',
    'pixel Picture alt Object fallback Video fallback Audio fallback SVG text',
    '',
    'Noscript fallback',
    '',
    'Marquee text',
    'Cell one | Cell two',
    'Image button',
    'Sum',
    'Details',
    'Link text',
    'Send Submit form',
].join('\n');

for (const csp of ['with-csp', 'without-csp'] as const)
{
    test.describe(csp, () =>
    {
        test('fixture 50 (HTML-only .eml) converts to the expected text, with nothing run or loaded', async ({ page }) =>
        {
            await open(page, csp);
            const expected = FIXTURES.find((f) => f.id === 'eml/50-html-only.eml');
            expect(expected).toBeDefined();
            if (expected === undefined)
            {
                return;
            }

            const result = await page.evaluate(
                async ({ url, name }) =>
                {
                    const entry = (await import(url)) as typeof Entry;
                    const parsers = entry.createBrowserParsers();
                    return parsers.eml.parse({ name, bytes: new TextEncoder().encode(entry.FIXTURE_50) });
                },
                { url: `${BUNDLE_PATH}${entryFile}`, name: expected.id },
            );

            expect(result.ok).toBe(true);
            if (!result.ok)
            {
                return;
            }
            const { bodyText, warnings } = result.message;
            for (const snippet of expected.bodyContains)
            {
                expect(bodyText).toContain(snippet);
            }
            for (const snippet of expected.bodyExcludes ?? [])
            {
                expect(bodyText).not.toContain(snippet);
            }
            expect([...warnings].sort()).toEqual([...expected.warnings].sort());
            // The whole text: CSS is ignored, so the "display: none" preheader is
            // kept (never silently lost); entities are decoded; links keep their
            // visible text only; the tracking pixels have no alt text.
            expect(bodyText).toBe(
                [
                    'Hidden preheader text',
                    'Dear Alice,',
                    'Spring offer on office chairs: order before 31 March and get 10\u00a0% off. Caf\u00e9 tables & meeting chairs included.',
                    'Book a visit',
                    'Sample Furniture \u2013 unsubscribe',
                ].join('\n\n'),
            );

            await expectNothingHappened(page);
        });

        test('hostile HTML: no script runs, nothing loads, only visible and fallback text comes out', async ({ page }) =>
        {
            await open(page, csp);
            const result = await convertInPage(page, HOSTILE_HTML);
            expect(result).toEqual({ text: HOSTILE_TEXT, truncated: false });
            await expectNothingHappened(page);
        });

        test('hostile HTML cut at a small output limit: truncated is reported, the note is in the text, nothing runs', async ({ page }) =>
        {
            await open(page, csp);
            const result = await convertInPage(page, HOSTILE_HTML, { maxDepth: 500, maxOutputLength: 40 });
            expect(result.truncated).toBe(true);
            expect(result.text.startsWith('Visible text\n\npixel Picture alt')).toBe(true);
            expect(result.text.endsWith('[Text cut here: this HTML body is longer than 40 characters. The full text stays in the original email file.]')).toBe(true);
            await expectNothingHappened(page);
        });
    });
}

test('deeply nested HTML converts without a crash and keeps its text', async ({ page }) =>
{
    await open(page, 'with-csp');
    const { text, truncated } = await convertInPage(page, `${'<div>'.repeat(20_000)}bottom${'</div>'.repeat(20_000)}<p>after</p>`);
    expect(truncated).toBe(false);
    expect(text).toContain('bottom');
    expect(text).toContain('after');
    await expectNothingHappened(page);
});

// Positive controls: prove the checks above would notice a leak. Moving
// parsed email nodes INTO the live page is exactly what the converter must
// never do.
test('control, with CSP: email images moved into the live page are blocked AND reported', async ({ page, browserName }) =>
{
    await open(page, 'with-csp');
    await page.evaluate((html) =>
    {
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        for (const img of Array.from(parsed.querySelectorAll('img')))
        {
            document.body.append(document.adoptNode(img));
        }
    }, HOSTILE_HTML);
    // Two reports about the LIVE page: the blocked remote image, and the
    // blocked inline handler of an image (fired at that element, so "live").
    // Chromium fires a blocked load's report at the document wherever the
    // element is, so the image's report says "parse": that label tells inline
    // reports apart only, and img-src is never tolerated whatever its label.
    const live = ['img-src https://tracker.invalid/p.png parse', 'script-src-attr inline live'];
    await expect.poll(() => page.evaluate(() => window.__e2eViolations)).toEqual(expect.arrayContaining(live));
    // The filter of expectNothingHappened rejects both.
    expect(untoleratedReports(browserName, await page.evaluate(() => window.__e2eViolations), isParseTimeReport)).toEqual(expect.arrayContaining(live));
    // Chromium lists the blocked image as a (failed) request; Firefox and
    // WebKit stop it before it becomes a request at all.
    if (browserName === 'chromium')
    {
        expect(requestsAfterLoad()).toEqual(expect.arrayContaining(['https://tracker.invalid/p.png']));
    }
    else
    {
        expect(requestsAfterLoad()).not.toContain('https://tracker.invalid/p.png');
    }
});

test('control, without CSP: email images moved into the live page load and run their handlers', async ({ page }) =>
{
    await open(page, 'without-csp');
    await page.evaluate((html) =>
    {
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        for (const img of Array.from(parsed.querySelectorAll('img')))
        {
            document.body.append(document.adoptNode(img));
        }
    }, HOSTILE_HTML);
    // The safety net aborts the remote request, but it is still seen; the
    // data: image loads and the broken one fails, so both handlers run.
    await expect.poll(() => requestsAfterLoad()).toEqual(expect.arrayContaining(['https://tracker.invalid/p.png']));
    await expect.poll(() => page.evaluate(() => window.__e2eFlags.sort())).toEqual(['img-onerror', 'img-onload']);
});

test('control, without CSP: an email <track> moved into the live page requests its URL', async ({ page, browserName }) =>
{
    test.skip(browserName !== 'chromium', 'backs the Chromium-only media-src tolerance; Firefox and WebKit tolerate no parse-time report');
    await open(page, 'without-csp');
    await page.evaluate(() =>
    {
        const parsed = new DOMParser().parseFromString(
            '<video id="e2e-track-control"><track default kind="captions" src="https://track.invalid/t.vtt"></video>',
            'text/html',
        );
        const video = parsed.querySelector('video');
        if (video)
        {
            document.body.append(document.adoptNode(video));
        }
    });
    // The safety net aborts the remote request, but it is still seen. This
    // proves the request listener would catch a real track load, so tolerating
    // the parse-time 'media-src https://track.invalid/t.vtt parse' report is safe.
    await expect.poll(() => requestsAfterLoad()).toEqual(expect.arrayContaining(['https://track.invalid/t.vtt']));
    await page.evaluate(() => document.getElementById('e2e-track-control')?.remove());
});
