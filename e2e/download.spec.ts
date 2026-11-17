// Browser test of step 3, "Make the PDF" (Source/page/download-step.ts,
// Source/worker-pipeline/pdf-runner.ts; README.md, rules R1, R2, R4 and R5), in
// each test browser against the BUILT site served by `vite preview` (see
// playwright.config.ts), with the real pipeline and the real PDF worker:
//
// - the whole flow: files added, the button pressed with the keyboard, the
//   PDF downloaded once by itself (Playwright's download event) with the
//   name correspondence-YYYY-MM-DD.pdf of the generation day in the page's
//   time zone; the file is a PDF whose pages and bookmarks are read back
//   with the test reader (tests/support/pdf-reader.ts); "Download again"
//   gives the same file again;
// - offline: the page loaded, then the network switched off, then files
//   added and the PDF made;
// - "Clear everything" while the PDF is being made: nothing is downloaded,
//   step 3 is back to the start, the PDF worker was stopped (right after
//   the press, and in the big batch below, with its worker really running);
// - unticking an email after the PDF is ready removes the stale link;
// - a big batch (2000 emails): the page stays responsive while the PDF is
//   made (no long main-thread task); the main-thread cost of handing the
//   job to the worker and the total time are printed.
//
// Throughout (see e2e/support/watch.ts): after the page's own files, the
// only requests are the blob: URLs of the inlined workers and of the PDF
// (both in memory, never the network), no WebSocket, no console error, no
// CSP violation in the page or a worker (the page's parse-time reports of
// DOMParser are tolerated as in e2e/full-flow.spec.ts; these emails are
// plain text, so none is expected), and every worker a parse, engine or PDF
// worker that ended.
//
// Test data is made up: tests/fixtures/eml and emails written here
// (invented people, *.test addresses).
import { readFileSync } from 'node:fs';
import { expect, test, type Download, type Page } from '@playwright/test';
import { en } from '../Source/page/translations/en.ts';
import { readOutline, readPdf } from '../tests/support/pdf-reader.ts';
// untoleratedReports: all but the CSP reports Chromium makes while DOMParser PARSES email HTML (see e2e/full-flow.spec.ts).
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
        __downloadViolations: string[];
    }
}

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

/** Node's Buffer (see e2e/add-files.spec.ts): what setInputFiles wants for in-memory files. */
const NodeBuffer = (globalThis as unknown as { Buffer: { from(bytes: Uint8Array): Uint8Array } }).Buffer;

type InputFile = { name: string; mimeType: string; buffer: never };

const textFile = (name: string, text: string): InputFile => ({
    name,
    mimeType: 'message/rfc822',
    buffer: NodeBuffer.from(new TextEncoder().encode(text)) as never,
});

/** A fixture as an in-memory file (the fixtures are 7-bit ASCII text). */
const fixture = (name: string): InputFile => textFile(name, readFileSync(`${ROOT}tests/fixtures/eml/${name}`, 'utf8'));

// A thread of four emails (Outlook- and Gmail-style replies) and one without a date.
const FILES = [
    fixture('10-order-1-alice.eml'),
    fixture('11-order-2-bob-outlook-en.eml'),
    fixture('12-order-3-alice-gmail.eml'),
    fixture('13-order-4-bob-outlook-nl.eml'),
    fixture('70-no-date.eml'),
];
const FILE_COUNT = FILES.length;

/** One made-up email of the big batch: one a day, from Alice or Carol in turn. */
function syntheticEmail(i: number): InputFile
{
    const n = String(i);
    const day = new Date(Date.UTC(2024, 0, 1, 9, i % 60) + i * 86_400_000).toUTCString().replace('GMT', '+0000');
    const from = i % 2 === 0 ? 'Alice Example <alice@example.test>' : 'Carol Test <carol@other.test>';
    const text = [
        `From: ${from}`,
        'To: Bob Sample <bob@sample.test>',
        `Subject: Garden bench order ${n}`,
        `Date: ${day}`,
        `Message-ID: <bench-order-${n}@example.test>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Hello Bob,',
        '',
        `This is note ${n} about the garden benches: the wood is oak, the paint is green,`,
        'and the delivery van comes on a weekday morning between eight and ten.',
        '',
        'Kind regards',
        '',
    ].join('\r\n');
    return textFile(`bench-order-${n}.eml`, text);
}

// The browser's zone: Tokyo (UTC+9, no daylight saving time), so the day of
// a PDF made at 20:00 UTC is already the next day there.
const ZONE = 'Asia/Tokyo';
test.use({ timezoneId: ZONE });
/** 2025-06-01 20:00 UTC = 2025-06-02 05:00 in Tokyo. */
const FIXED_NOW = new Date('2025-06-01T20:00:00Z');
const FILE_NAME = 'correspondence-2025-06-02.pdf';

let origin = '';
let watch: Watch;
let loadedAt = 0;
let problems: string[] = [];
let downloads: Download[] = [];

test.beforeEach(async ({ context, page, baseURL }) =>
{
    origin = new URL(baseURL ?? '').origin;
    problems = [];
    downloads = [];
    watch = await watchPage(context, page, origin);
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
    page.on('download', (download) => downloads.push(download));
    await page.addInitScript(() =>
    {
        window.__downloadViolations = [];
        document.addEventListener('securitypolicyviolation', (event) =>
        {
            // "select": WebKit's report about a <select> (see withoutSelectReports).
            const where = event.target === document ? 'parse' : event.target instanceof HTMLSelectElement ? 'select' : 'live';
            window.__downloadViolations.push(`${event.effectiveDirective} ${event.blockedURI} ${where}`);
        });
    });
});

async function open(page: Page): Promise<void>
{
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('#drop-zone')).toBeVisible();
    loadedAt = watch.requests.length;
}

const makeButton = (page: Page) => page.getByRole('button', { name: en.actions.makePdf });
const area = (page: Page) => page.locator('#download-area');
const link = (page: Page) => page.locator('#download-link');

/** Adds `files` and waits until the list and its PDF plans are ready (the button is available). */
async function addFiles(page: Page, files: readonly InputFile[], emails: number, timeout = 60_000): Promise<void>
{
    await page.locator('#file-input').setInputFiles([...files]);
    await expect(page.locator('#preview-list > li')).toHaveCount(emails, { timeout });
    await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/, { timeout });
    await expect(makeButton(page)).not.toHaveAttribute('aria-disabled', /.*/, { timeout });
    await expect(page.locator('#download-note')).toHaveText(en.download.available);
}

/** The downloaded file's bytes. */
async function bytesOf(download: Download): Promise<Uint8Array>
{
    return new Uint8Array(readFileSync(await download.path()));
}

/** "Your PDF is ready: <name>, N pages. ..." -> N. */
function pagesInStatus(text: string): number
{
    const match = /, (\d+) pages?\./.exec(text);
    if (match === null)
    {
        throw new Error(`no page count in ${text}`);
    }
    return Number(match[1]);
}

/**
 * Once everything has settled: only blob: requests after the page's files,
 * no WebSocket, no CSP violation, every worker a known one that ended, no
 * console error or dialog, nothing stored.
 */
async function expectNothingLeftThePage(page: Page): Promise<void>
{
    await page.waitForTimeout(500);
    const ownBlob = new RegExp(`^blob:${origin}/[0-9a-f-]+$`);
    for (const url of watch.requests.slice(loadedAt))
    {
        expect(url).toMatch(ownBlob);
    }
    expect(watch.requests.every((url) => url.startsWith('blob:') || new URL(url).origin === origin)).toBe(true);
    expect(watch.websockets).toEqual([]);
    const browserName = engineOf(page.context());
    const violations = withoutSelectReports(browserName, await page.evaluate(() => window.__downloadViolations));
    expect(untoleratedReports(browserName, violations)).toEqual([]);
    expect(workerCspReports(watch)).toEqual([]);
    const named = (['parse-worker', 'engine-worker', 'pdf-worker'] as const).reduce((sum, name) => sum + workersNamed(watch, watch.workers, name).length, 0);
    expect(named).toBe(watch.workers.length);
    await expect.poll(() => watch.closedWorkers.length).toBe(watch.workers.length);
    expect(withoutSelectConsole(browserName, problems)).toEqual([]);
    const stored = await page.evaluate(async () => ({
        localStorage: localStorage.length,
        sessionStorage: sessionStorage.length,
        indexedDB: (await indexedDB.databases()).length,
        caches: (await caches.keys()).length,
        cookie: document.cookie,
    }));
    expect(stored).toEqual({ localStorage: 0, sessionStorage: 0, indexedDB: 0, caches: 0, cookie: '' });
}

test('makes the PDF with the keyboard, downloads it once by itself, and offers it again', async ({ page }) =>
{
    test.setTimeout(120_000);
    await page.clock.setFixedTime(FIXED_NOW);
    await open(page);
    await addFiles(page, FILES, FILE_COUNT);
    await expect(page.getByLabel(en.preview.zone)).toHaveValue(ZONE);
    expect(downloads).toEqual([]);
    await expect(link(page)).toBeHidden();

    // Keyboard: focus the button, press Enter.
    const first = page.waitForEvent('download');
    await makeButton(page).focus();
    await page.keyboard.press('Enter');
    const download = await first;
    expect(download.suggestedFilename()).toBe(FILE_NAME);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    const status = (await page.getByRole('status').textContent()) ?? '';
    expect(status).toMatch(new RegExp(`^Your PDF is ready: ${FILE_NAME.replaceAll('.', '\\.')}, \\d+ pages\\. The download has started\\.$`));
    await expect(page.locator('#download-note')).toHaveText(status);
    // Not more than once by itself.
    await page.waitForTimeout(500);
    expect(downloads).toHaveLength(1);

    // The file: a PDF with the stated pages, one bookmark per email.
    const bytes = await bytesOf(download);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    const pdf = readPdf(bytes);
    expect(pdf.pages()).toHaveLength(pagesInStatus(status));
    const titles = (readOutline(pdf)?.items ?? []).map((item) => item.title);
    expect(titles[0]).toBe(en.pdf.document.coverBookmark);
    expect(titles.filter((title) => title.includes('Office desks and chairs'))).toHaveLength(4);
    expect(titles.filter((title) => title.includes('Spare chair'))).toHaveLength(1);
    // Dated in Tokyo time: the first email (2025-03-03 08:15 UTC) is on 3 March there too.
    expect(titles.some((title) => title.startsWith('1. 2025-03-03, '))).toBe(true);

    // "Download again": a link in the page, with the PDF's blob: URL and name.
    await expect(link(page)).toBeVisible();
    await expect(link(page)).toHaveText(`Download again: ${FILE_NAME}`);
    await expect(link(page)).toHaveAttribute('download', FILE_NAME);
    await expect(link(page)).toHaveAttribute('href', new RegExp(`^blob:${origin}/[0-9a-f-]+$`));
    const second = page.waitForEvent('download');
    await link(page).click();
    const again = await second;
    expect(again.suggestedFilename()).toBe(FILE_NAME);
    expect([...(await bytesOf(again))]).toEqual([...bytes]);

    // Exactly one PDF worker, and it ended.
    expect(workersNamed(watch, watch.workers, 'pdf-worker')).toHaveLength(1);
    await expectNothingLeftThePage(page);
});

test('works offline: the page loaded, then the network off, then the files and the PDF', async ({ context, page }) =>
{
    test.setTimeout(120_000);
    await page.clock.setFixedTime(FIXED_NOW);
    await open(page);
    await context.setOffline(true);
    await addFiles(page, FILES, FILE_COUNT);
    const next = page.waitForEvent('download');
    await makeButton(page).click();
    const download = await next;
    expect(download.suggestedFilename()).toBe(FILE_NAME);
    const bytes = await bytesOf(download);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    const titles = (readOutline(readPdf(bytes))?.items ?? []).map((item) => item.title);
    // The cover, the index, then one bookmark per email.
    expect(titles).toHaveLength(2 + FILE_COUNT);
    await context.setOffline(false);
    await expectNothingLeftThePage(page);
});

test('"Clear everything" while the PDF is being made: no download, step 3 back to the start', async ({ page }) =>
{
    test.setTimeout(120_000);
    await open(page);
    await addFiles(page, FILES, FILE_COUNT);
    // Both presses in one go, so the PDF cannot be finished in between.
    const state = await page.evaluate(() =>
    {
        document.querySelector<HTMLButtonElement>('#download-button')?.click();
        const making = document.querySelector('#download-area')?.getAttribute('data-state');
        document.querySelector<HTMLButtonElement>('#clear-everything')?.click();
        return { making, after: document.querySelector('#download-area')?.getAttribute('data-state') };
    });
    expect(state).toEqual({ making: 'making', after: 'idle' });
    await expect(page.getByRole('status')).toHaveText(en.clear.done);
    await expect(makeButton(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#download-note')).toHaveText(en.download.unavailable['no-emails']);
    await expect(link(page)).toBeHidden();
    await expect(link(page)).not.toHaveAttribute('href', /.*/);
    // The PDF worker was terminated in the same task it was started in, so
    // Chromium may not even report it; any it reports has ended. Nothing was
    // downloaded, even after a while.
    await page.waitForTimeout(1500);
    expect(workersNamed(watch, watch.closedWorkers, 'pdf-worker')).toHaveLength(workersNamed(watch, watch.workers, 'pdf-worker').length);
    expect(downloads).toEqual([]);
    await expect(area(page)).toHaveAttribute('data-state', 'idle');
    await expectNothingLeftThePage(page);
});

test('unticking an email after the PDF is ready removes the stale link; a new PDF follows the choice', async ({ page }) =>
{
    test.setTimeout(120_000);
    await page.clock.setFixedTime(FIXED_NOW);
    await open(page);
    await addFiles(page, FILES, FILE_COUNT);
    const first = page.waitForEvent('download');
    await makeButton(page).click();
    const before = readPdf(await bytesOf(await first));
    await expect(link(page)).toBeVisible();

    // Untick the email without a date (the last one in the list).
    await page.locator('#preview-list > li').last().getByRole('checkbox', { name: en.actions.include }).uncheck();
    await expect(link(page)).toBeHidden();
    await expect(link(page)).not.toHaveAttribute('href', /.*/);
    await expect(area(page)).toHaveAttribute('data-state', 'idle');
    await expect(page.locator('#download-note')).toHaveText(en.download.changed);
    await expect(makeButton(page)).not.toHaveAttribute('aria-disabled', /.*/);

    const second = page.waitForEvent('download');
    await makeButton(page).click();
    const after = readPdf(await bytesOf(await second));
    const titles = (pdf: typeof before) => (readOutline(pdf)?.items ?? []).map((item) => item.title);
    expect(titles(before).some((title) => title.includes('Spare chair'))).toBe(true);
    expect(titles(after).some((title) => title.includes('Spare chair'))).toBe(false);
    expect(titles(after).filter((title) => title.includes('Office desks and chairs'))).toHaveLength(4);
    expect(downloads).toHaveLength(2);
    await expectNothingLeftThePage(page);
});

test('a big batch: the page stays responsive while the PDF is made', async ({ page }) =>
{
    const COUNT = 2000;
    test.setTimeout(600_000);
    await open(page);
    const startedAt = Date.now();
    await addFiles(
        page,
        Array.from({ length: COUNT }, (_, i) => syntheticEmail(i + 1)),
        COUNT,
        480_000,
    );
    const readMs = Date.now() - startedAt;

    // A heartbeat every 10 ms and the browser's long-task entries (tasks over
    // 50 ms on the main thread), recorded from the press until the PDF is ready.
    await page.evaluate(() =>
    {
        const w = window as unknown as { __beat: { last: number; maxGap: number; timer: number }; __long: number[] };
        w.__long = [];
        new PerformanceObserver((list) =>
        {
            for (const entry of list.getEntries())
            {
                w.__long.push(entry.duration);
            }
        }).observe({ type: 'longtask' });
        w.__beat = { last: performance.now(), maxGap: 0, timer: 0 };
        w.__beat.timer = window.setInterval(() =>
        {
            const now = performance.now();
            w.__beat.maxGap = Math.max(w.__beat.maxGap, now - w.__beat.last);
            w.__beat.last = now;
        }, 10);
    });
    const next = page.waitForEvent('download', { timeout: 300_000 });
    const clickedAt = Date.now();
    // The press itself: building the request and handing it to the worker
    // (the browser copies the emails, plans and fonts during postMessage).
    const handOffMs = await page.evaluate(() =>
    {
        const t0 = performance.now();
        document.querySelector<HTMLButtonElement>('#download-button')?.click();
        return performance.now() - t0;
    });
    const download = await next;
    const makeMs = Date.now() - clickedAt;
    const responsiveness = await page.evaluate(() =>
    {
        const w = window as unknown as { __beat: { last: number; maxGap: number; timer: number }; __long: number[] };
        window.clearInterval(w.__beat.timer);
        return { maxGap: w.__beat.maxGap, longTasks: w.__long };
    });
    const bytes = await bytesOf(download);
    const pdf = readPdf(bytes);
    const titles = (readOutline(pdf)?.items ?? []).map((item) => item.title);
    console.log(
        `[download.spec] ${String(COUNT)} emails: read ${String(readMs)} ms; press (hand-off to the worker) ${handOffMs.toFixed(1)} ms; ` +
            `press to download ${String(makeMs)} ms; ${String(pdf.pages().length)} pages, ${(bytes.length / 1e6).toFixed(2)} MB; ` +
            `longest heartbeat gap ${responsiveness.maxGap.toFixed(0)} ms; long tasks ${JSON.stringify(responsiveness.longTasks.map(Math.round))}`,
    );
    expect(download.suggestedFilename()).toMatch(/^correspondence-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(titles.filter((title) => title.includes('Garden bench order'))).toHaveLength(COUNT);
    // Responsive: no main-thread task anywhere near a freeze while the worker works.
    expect(handOffMs).toBeLessThan(500);
    expect(Math.max(0, ...responsiveness.longTasks)).toBeLessThan(500);
    expect(responsiveness.maxGap).toBeLessThan(500);

    // "Clear everything" while this big PDF is being made again, its worker
    // really running: it is stopped, and nothing more is downloaded.
    const pdfWorkers = (list: Watch['workers']): number => workersNamed(watch, list, 'pdf-worker').length;
    const started = pdfWorkers(watch.workers);
    await makeButton(page).click();
    await expect.poll(() => pdfWorkers(watch.workers), { intervals: [10] }).toBe(started + 1);
    const stateAtClear = await page.evaluate(() =>
    {
        const state = document.querySelector('#download-area')?.getAttribute('data-state');
        document.querySelector<HTMLButtonElement>('#clear-everything')?.click();
        return state;
    });
    expect(stateAtClear).toBe('making');
    await expect.poll(() => pdfWorkers(watch.closedWorkers)).toBe(started + 1);
    await expect(area(page)).toHaveAttribute('data-state', 'idle');
    await expect(link(page)).toBeHidden();
    await page.waitForTimeout(2000);
    expect(downloads).toHaveLength(1);
    await expectNothingLeftThePage(page);
});
