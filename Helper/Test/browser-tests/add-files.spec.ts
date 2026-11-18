// Browser test of step 1, adding email files (README.md, rules R1, R2, R4
// and R5), in each test browser against the BUILT site served by `vite preview` (see
// playwright.config.ts). The real pipeline runs: the parse and engine
// workers are inlined in the page's script and started from blob: URLs, under
// the page's own CSP.
//
// Files: synthetic fixtures from Helper/Test/test-data/eml (given to the browser by
// path) and a synthetic .msg built in memory from Helper/Test/test-data/msg (given
// as a buffer). Drag-and-drop is simulated with a DataTransfer made in the
// page and DragEvents dispatched on the drop zone: Playwright cannot drag a
// file from the operating system.
//
// Every test also checks, once processing has settled, that nothing (page or
// worker) made a request other than starting the inlined workers from their
// blob: URLs (memory, not network), that there was no CSP violation (page or
// worker), and that there was no console error. See Helper/Test/browser-tests/support/network-and-csp-watch.ts for
// the detectors.
//
// The offline tests at the end switch the network off right after the page
// has loaded, then use the tool: the way a user checks that nothing needs
// the internet (README.md, "how to verify").
import { expect, test, type FileChooser, type Page } from '@playwright/test';
import { createServer } from 'vite';
import { en } from '../../../Source/web-page/translations/en.ts';
import type * as Builder from '../test-data/msg/builder.ts';
import type * as Specs from '../test-data/msg/specs.ts';
import { tabSkipsLinks } from './support/keyboard.ts';
import { engineOf, watchPage, withoutSelectConsole, withoutSelectReports, workerCspReports, workersNamed, type Watch } from './support/network-and-csp-watch.ts';

declare global
{
    interface Window
    {
        __addViolations: string[];
        /** Every text the status line showed, and whether the progress bar was ever shown. */
        __addSeen: { statuses: string[]; progressShown: boolean };
    }
}

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('../../..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const fixture = (name: string): string => `${ROOT}Helper/Test/test-data/eml/${name}`;

// A short order thread (10 -> 11) and an exact copy of 11 (merged by the engine).
const ORDER_1 = fixture('10-order-1-alice.eml');
const ORDER_2 = fixture('11-order-2-bob-outlook-en.eml');
const ORDER_2_COPY = fixture('30-dup-order-2-copy.eml');

/** A well-formed synthetic .msg (the first spec of the fixture set), as bytes. Built in beforeAll. */
let goodMsgBytes: number[] = [];
const goodMsg = (): number[] => goodMsgBytes;

test.beforeAll(async () =>
{
    // The .msg builder imports msgreader's files without their extension,
    // which Vite resolves but Node's own module loader does not. So it is
    // loaded through Vite's module loader, with the project's config. In
    // middleware mode Vite opens no port and serves nothing: it only loads
    // the module here, in the test process.
    const server = await createServer({
        root: ROOT,
        configFile: `${ROOT}vite.config.ts`,
        logLevel: 'warn',
        appType: 'custom',
        server: { middlewareMode: true, hmr: false, ws: false },
    });
    try
    {
        const { buildMsg } = (await server.ssrLoadModule('/Helper/Test/test-data/msg/builder.ts')) as typeof Builder;
        const { MSG_SPECS } = (await server.ssrLoadModule('/Helper/Test/test-data/msg/specs.ts')) as typeof Specs;
        const spec = MSG_SPECS[0];
        if (spec === undefined)
        {
            throw new Error('no .msg spec');
        }
        goodMsgBytes = Array.from(buildMsg(spec));
    }
    finally
    {
        await server.close();
    }
    expect(goodMsgBytes.length).toBeGreaterThan(1000);
});

/**
 * Node's Buffer, which Playwright's setInputFiles wants for in-memory files.
 * Reached through globalThis because the project has no Node type
 * definitions (the tests run in Node, where Buffer always exists).
 */
const NodeBuffer = (globalThis as unknown as { Buffer: { from(bytes: number[]): Uint8Array } }).Buffer;

/** Files made inside the page for a drop. */
type ExtraFile = { readonly name: string; readonly bytes: number[] } | { readonly name: string; readonly hugeMegabytes: number };

let origin = '';
let watch: Watch;
let loadedAt = 0;
let problems: string[] = [];

test.beforeEach(async ({ context, page, baseURL }) =>
{
    origin = new URL(baseURL ?? '').origin;
    problems = [];
    watch = await watchPage(context, page, origin);
    page.on('console', (message) =>
    {
        if (message.type() === 'error')
        {
            problems.push(`console: ${message.text()}`);
        }
    });
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    await page.addInitScript(() =>
    {
        window.__addViolations = [];
        document.addEventListener('securitypolicyviolation', (event) =>
        {
            // "select": WebKit's report about a <select> (see withoutSelectReports).
            window.__addViolations.push(`${event.effectiveDirective} ${event.blockedURI}${event.target instanceof HTMLSelectElement ? ' select' : ''}`);
        });
    });
});

/** Opens the page, then starts recording the status line and the progress bar. */
async function open(page: Page): Promise<void>
{
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('#drop-zone')).toBeVisible();
    loadedAt = watch.requests.length;
    await page.evaluate(() =>
    {
        const status = document.getElementById('status');
        const progress = document.getElementById('add-progress');
        if (!status || !progress)
        {
            throw new Error('step 1 is missing');
        }
        window.__addSeen = { statuses: [], progressShown: false };
        new MutationObserver(() =>
        {
            if (status.textContent)
            {
                window.__addSeen.statuses.push(status.textContent);
            }
        }).observe(status, { childList: true, characterData: true, subtree: true });
        new MutationObserver(() =>
        {
            if (!progress.hidden)
            {
                window.__addSeen.progressShown = true;
            }
        }).observe(progress, { attributes: true, attributeFilter: ['hidden'] });
    });
}

/** Waits until step 1 shows `summary` and is no longer busy. */
async function expectSummary(page: Page, summary: string): Promise<void>
{
    await expect(page.locator('#add-summary-text')).toHaveText(summary, { timeout: 30_000 });
    await expect(page.locator('#add-area')).not.toHaveAttribute('aria-busy', /.*/);
    await expect(page.locator('#add-progress')).toBeHidden();
}

/**
 * Step 2 is open: its container is no longer hidden, the "waiting" note is
 * gone. (The container itself stays empty, so not visible, until the preview
 * is built into it.)
 */
async function expectCheckReady(page: Page): Promise<void>
{
    await expect(page.locator('#check-area')).not.toHaveAttribute('hidden', /.*/);
    await expect(page.locator('#check-waiting')).toBeHidden();
    await expect(page.locator('#step-check')).toHaveAttribute('data-state', 'ready');
}

/**
 * Drops files on `selector` the way a browser does (dragenter, dragover,
 * drop, all bubbling to the page-wide listeners). Fixture files are first put
 * in a temporary input OUTSIDE the app (Playwright can only hand real files
 * to an input), then moved into a DataTransfer; `extra` files are made in the
 * page. Returns whether each event's default action was cancelled.
 */
async function dropFiles(page: Page, selector: string, paths: readonly string[], extra: readonly ExtraFile[] = []): Promise<boolean[]>
{
    const holder = await page.evaluateHandle(() =>
    {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.hidden = true;
        document.body.append(input);
        return input;
    });
    const holderInput = holder.asElement();
    if (holderInput === null)
    {
        throw new Error('no input');
    }
    if (paths.length > 0)
    {
        await holderInput.setInputFiles([...paths]);
    }
    return page.evaluate(
        ({ input, selector: target, extra: made }) =>
        {
            const data = new DataTransfer();
            for (const file of input.files ?? [])
            {
                data.items.add(file);
            }
            input.remove();
            for (const item of made)
            {
                if ('bytes' in item)
                {
                    data.items.add(new File([new Uint8Array(item.bytes)], item.name));
                }
                else
                {
                    // One 1 MB blob listed many times: the browser knows the size
                    // without allocating it all.
                    const chunk = new Blob([new Uint8Array(1024 * 1024)]);
                    data.items.add(new File(Array.from({ length: item.hugeMegabytes }, () => chunk), item.name));
                }
            }
            const element = document.querySelector(target);
            if (!element)
            {
                throw new Error(`no ${target}`);
            }
            return ['dragenter', 'dragover', 'drop'].map(
                (type) => !element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data })),
            );
        },
        { input: holder, selector, extra },
    );
}

/** Requests since the page loaded. */
const requestsAfterLoad = (): string[] => watch.requests.slice(loadedAt);

/** The parse / engine workers started so far. */
const parseWorkers = (): number => workersNamed(watch, watch.workers, 'parse-worker').length;
const engineWorkers = (): number => workersNamed(watch, watch.workers, 'engine-worker').length;

/**
 * After processing has settled (a quiet period): the only "requests" after
 * load are the blob: URLs the inlined workers start from (on the site's own
 * origin, read from memory), nothing else; no WebSocket; no CSP violation in
 * the page or any worker; every worker ended and is a parse or engine
 * worker; no console error; the page is still the app.
 */
async function expectNothingLeftThePage(page: Page): Promise<void>
{
    await page.waitForTimeout(1000);
    const workerUrls = new Set(watch.workers.map((w) => w.url()));
    for (const url of workerUrls)
    {
        expect(url).toMatch(new RegExp(`^blob:${origin}/[0-9a-f-]+$`));
    }
    expect(requestsAfterLoad().filter((url) => !workerUrls.has(url))).toEqual([]);
    expect(parseWorkers() + engineWorkers()).toBe(watch.workers.length);
    expect(watch.requests.every((url) => new URL(url).origin === origin)).toBe(true);
    expect(watch.websockets).toEqual([]);
    const browserName = engineOf(page.context());
    expect(withoutSelectReports(browserName, await page.evaluate(() => window.__addViolations))).toEqual([]);
    expect(workerCspReports(watch)).toEqual([]);
    await expect.poll(() => watch.closedWorkers.length).toBe(watch.workers.length);
    expect(withoutSelectConsole(browserName, problems)).toEqual([]);
    expect(await page.title()).toBe(en.app.name);
}

test('choose files: progress is shown, the summary is right and step 2 opens', async ({ page }) =>
{
    test.setTimeout(60_000);
    await open(page);
    const url = page.url();

    // Playwright takes either paths or in-memory files in one call, not both:
    // the .eml fixtures first, then the .msg built in memory.
    await page.locator('#file-input').setInputFiles([ORDER_1, ORDER_2, ORDER_2_COPY]);
    await expectSummary(page, '3 files added. 3 emails found. 1 identical copy merged.');
    await page
        .locator('#file-input')
        .setInputFiles([{ name: 'good.msg', mimeType: 'application/vnd.ms-outlook', buffer: NodeBuffer.from(goodMsg()) as never }]);

    await expectSummary(page, '4 files added. 4 emails found. 1 identical copy merged.');
    await expectCheckReady(page);
    await expect(page.locator('#add-failed')).toBeHidden();
    await expect(page.locator('#add-batch-error')).toBeHidden();
    await expect(page.getByRole('status')).toHaveText('4 files added. 4 emails found. 1 identical copy merged.');

    const seen = await page.evaluate(() => window.__addSeen);
    expect(seen.progressShown).toBe(true);
    // The status line: one text per round with no file number (the progress line has those).
    expect(seen.statuses).toContain(en.drop.readingMany.replace('{total}', '3'));
    expect(seen.statuses).toContain(en.drop.readingMany.replace('{total}', '4'));
    expect(seen.statuses.filter((s) => s.startsWith('Reading file'))).toEqual([]);
    expect(seen.statuses).toContain(en.drop.organizing);
    // One parse worker per file read (3, then all 4 again), one engine worker per round.
    expect(parseWorkers()).toBe(7);
    expect(engineWorkers()).toBe(2);
    expect(page.url()).toBe(url);

    await expectNothingLeftThePage(page);
});

test('drag and drop on the zone: same result, and the drag-over state shows', async ({ page }) =>
{
    test.setTimeout(60_000);
    await open(page);

    // The zone lights up while files are over it.
    const state = await page.evaluate(() =>
    {
        const zone = document.getElementById('drop-zone');
        const data = new DataTransfer();
        data.items.add(new File(['x'], 'x.eml'));
        zone?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
        const over = zone?.getAttribute('data-state');
        document.body.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: null, dataTransfer: data }));
        return [over, zone?.getAttribute('data-state')];
    });
    expect(state).toEqual(['over', 'idle']);

    const prevented = await dropFiles(page, '#drop-zone .drop-zone-text', [ORDER_1, ORDER_2, ORDER_2_COPY], [{ name: 'good.msg', bytes: goodMsg() }]);
    expect(prevented).toEqual([true, true, true]);

    await expectSummary(page, '4 files added. 4 emails found. 1 identical copy merged.');
    await expectCheckReady(page);
    await expectNothingLeftThePage(page);
});

test('files dropped outside the zone are not added and the page does not navigate away', async ({ page }) =>
{
    test.setTimeout(60_000);
    await open(page);
    const url = page.url();
    await page.locator('#file-input').setInputFiles([ORDER_1]);
    await expectSummary(page, '1 file added. 1 email found.');

    for (const selector of ['#step-download', 'footer', 'body'])
    {
        const prevented = await dropFiles(page, selector, [ORDER_2]);
        // Cancelled: the browser would otherwise open the file in place of the app.
        expect(prevented, selector).toEqual([true, true, true]);
        await expect(page.getByRole('status')).toHaveText(en.drop.outside);
    }
    await page.waitForTimeout(500);
    expect(page.url()).toBe(url);
    // The work so far is intact and nothing new was read.
    await expect(page.locator('#add-summary-text')).toHaveText('1 file added. 1 email found.');
    await expectCheckReady(page);
    expect(parseWorkers()).toBe(1);

    await expectNothingLeftThePage(page);
});

test('an unsupported and an oversized file are listed with readable reasons; the other files are still read', async ({ page }) =>
{
    test.setTimeout(60_000);
    await open(page);

    await dropFiles(
        page,
        '#drop-zone',
        [ORDER_1],
        [
            { name: 'notes.txt', bytes: Array.from(new TextEncoder().encode('Order notes, not an email.')) },
            { name: 'huge.eml', hugeMegabytes: 51 },
            { name: 'good.msg', bytes: goodMsg() },
        ],
    );

    await expectSummary(page, '4 files added. 2 could not be read. 2 emails found.');
    await expectCheckReady(page);
    const failed = page.locator('#add-failed');
    await expect(failed.getByRole('heading', { level: 3 })).toHaveText(en.added.failedTitle);
    const items = page.locator('#add-failed-list > li');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0).locator('.failed-reason')).toHaveText(`notes.txt ${en.errors.file['unsupported-type']}`);
    await expect(items.nth(1).locator('.failed-reason')).toHaveText(`huge.eml ${en.errors.file['too-large']}`);
    // The technical detail is folded away until asked for.
    const detail = items.nth(1).locator('.failed-detail');
    await expect(detail).toBeHidden();
    await items.nth(1).getByText(en.added.details).click();
    await expect(detail).toHaveText('the file is larger than 50 MB, the limit for one file');
    // Neither failed file reached a parse worker.
    expect(parseWorkers()).toBe(2);

    await expectNothingLeftThePage(page);
});

test('adding more files later re-reads the whole list; the same file added twice is merged', async ({ page }) =>
{
    test.setTimeout(60_000);
    await open(page);

    await page.locator('#file-input').setInputFiles([ORDER_1]);
    await expectSummary(page, '1 file added. 1 email found.');
    await page.locator('#file-input').setInputFiles([ORDER_2]);
    await expectSummary(page, '2 files added. 2 emails found.');
    // The same file again, by drag-and-drop this time.
    await dropFiles(page, '#drop-zone', [ORDER_1]);
    await expectSummary(page, '3 files added. 3 emails found. 1 identical copy merged.');
    await expectCheckReady(page);
    // Each round reads every file of the list: 1 + 2 + 3 parse workers.
    expect(parseWorkers()).toBe(6);

    await expectNothingLeftThePage(page);
});

test('keyboard: Tab reaches the button right after the privacy panel and the step 1 help, and Enter or Space opens the file chooser', async ({ page, browserName }) =>
{
    test.setTimeout(60_000);
    await open(page);

    // Playwright starts intercepting file choosers when the first listener is
    // added, asynchronously: listen first, and let one round trip to the page
    // pass, so a key press cannot win that race (seen when tests run in parallel).
    const choosers: FileChooser[] = [];
    page.on('filechooser', (chooser) => choosers.push(chooser));
    await page.evaluate(() => 0);

    // The language picker comes first (its ticked radio), then the Ko-fi
    // button (skipped by Tab in WebKit, see Helper/Test/browser-tests/support/keyboard.ts) and the
    // privacy panel's summary in the header (Helper/Test/browser-tests/privacy.spec.ts), then step
    // 1's help (Helper/Test/browser-tests/help.spec.ts).
    await page.keyboard.press('Tab');
    await expect(page.locator('#lang-en')).toBeFocused();
    if (!tabSkipsLinks(browserName))
    {
        await page.keyboard.press('Tab');
        await expect(page.locator('#donate-link')).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect(page.locator('#privacy-summary')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#help-summary')).toBeFocused();
    await page.keyboard.press('Tab');
    const button = page.getByRole('button', { name: en.actions.chooseFiles });
    await expect(button).toBeFocused();
    await expect(button).toHaveAccessibleDescription(en.drop.accepted);

    await page.keyboard.press('Enter');
    await expect.poll(() => choosers.length).toBe(1);
    const chooser = choosers[0];
    expect(chooser?.isMultiple()).toBe(true);
    await chooser?.setFiles([ORDER_1]);
    await expectSummary(page, '1 file added. 1 email found.');
    await expectCheckReady(page);

    // Focus stayed on the button; Space opens the chooser again to add more.
    await expect(button).toBeFocused();
    await page.keyboard.press('Space');
    await expect.poll(() => choosers.length).toBe(2);
    await choosers[1]?.setFiles([ORDER_2]);
    await expectSummary(page, '2 files added. 2 emails found.');

    await expectNothingLeftThePage(page);
});

test.describe('offline right after the page has loaded', () =>
{
    test('.eml files and a .msg give the full result, with no request possible', async ({ page, context }) =>
    {
        test.setTimeout(60_000);
        await open(page);
        // The PDF fonts came with the page, before going offline: their chunk
        // was requested once during the load, and the page entry has checked
        // them (Source/main.ts sets the flag only after reading their headers).
        const fontChunk = /^\/assets\/pdf-fonts-[\w-]+\.js$/;
        expect(watch.requests.slice(0, loadedAt).filter((url) => fontChunk.test(new URL(url).pathname))).toHaveLength(1);
        await expect(page.locator('html')).toHaveAttribute('data-pdf-fonts', 'ready');
        // From here on the browser has no network at all, as if the cable were pulled.
        await context.setOffline(true);

        await page.locator('#file-input').setInputFiles([ORDER_1, ORDER_2, ORDER_2_COPY]);
        await expectSummary(page, '3 files added. 3 emails found. 1 identical copy merged.');
        await page
            .locator('#file-input')
            .setInputFiles([{ name: 'good.msg', mimeType: 'application/vnd.ms-outlook', buffer: NodeBuffer.from(goodMsg()) as never }]);
        await expectSummary(page, '4 files added. 4 emails found. 1 identical copy merged.');

        await expectCheckReady(page);
        await expect(page.locator('#add-failed')).toBeHidden();
        await expect(page.locator('#add-batch-error')).toBeHidden();
        // Every worker really started: one parse worker per file read, one engine worker per round.
        expect(parseWorkers()).toBe(7);
        expect(engineWorkers()).toBe(2);
        // Nothing after load but the workers' blob: URLs (never the network).
        expect(requestsAfterLoad().every((url) => url.startsWith(`blob:${origin}/`))).toBe(true);
        await expectNothingLeftThePage(page);
    });

    test('a damaged file still gets a calm message of its own; the other file is read', async ({ page, context }) =>
    {
        test.setTimeout(60_000);
        await open(page);
        await context.setOffline(true);

        // A .msg cut short: its structure is broken (a real damaged file).
        await dropFiles(page, '#drop-zone', [ORDER_1], [{ name: 'cut-off.msg', bytes: goodMsg().slice(0, 700) }]);
        await expectSummary(page, '2 files added. 1 could not be read. 1 email found.');
        await expectCheckReady(page);
        const items = page.locator('#add-failed-list > li');
        await expect(items).toHaveCount(1);
        await expect(items.nth(0).locator('.failed-reason')).toHaveText(`cut-off.msg ${en.errors.file.corrupt}`);
        await expect(items.nth(0).locator('.failed-detail')).toHaveText(/^damaged file structure: /);
        await expect(page.locator('#add-batch-error')).toBeHidden();
        expect(parseWorkers()).toBe(2);
        await expectNothingLeftThePage(page);
    });
});
