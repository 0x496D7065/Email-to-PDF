// Browser test of step 2, the preview (README.md, rules R1, R2, R4, R5 and
// R6), in each test browser against the BUILT site served by `vite preview` (see
// playwright.config.ts). The real pipeline runs on synthetic fixtures from
// Helper/Test/test-data/eml, added through the file input.
//
// The browser's time zone is fixed to Africa/Lagos (UTC+01:00 all year, no
// daylight saving time) so the default dates are known, and match the +0100
// of the fixtures, so the sender's own time is hidden. Every test also
// checks, once everything has settled, that nothing left the page (only the inlined workers' blob: URLs), that there
// was no CSP violation (page or worker) and no console error. See
// Helper/Test/browser-tests/support/network-and-csp-watch.ts for the detectors.
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../../../Source/web-page/translations/en.ts';
import { contrastFailures } from './support/contrast.ts';
import { browserEngineOf, watchPage, withoutSelectConsole, withoutSelectReports, workerCspReports,
    type PageWatch } from './support/network-and-csp-watch.ts';

declare global
{
    interface Window
    {
        __previewViolations: string[];
    }
}

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('../../..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const fixture = (name: string): string => `${ROOT}Helper/Test/test-data/eml/${name}`;

/**
 * The body of a plain-text, 7bit fixture as written in the file: everything
 * after the first blank line, line ends as "\n". Only for fixtures with no
 * transfer encoding and no lone CR, where this is exactly the email's text.
 */
function plainBody(name: string): string
{
    const raw = readFileSync(fixture(name), 'utf8').replaceAll('\r\n', '\n');
    const start = raw.indexOf('\n\n');
    if (start < 0 || raw.includes('\r'))
    {
        throw new Error(`${name} is not a simple plain-text fixture`);
    }
    return raw.slice(start + 2);
}

// Added in a shuffled order; the preview must show them by date, the undated one last.
const FILES = [
    '13-order-4-bob-outlook-nl.eml',
    '70-no-date.eml',
    '10-order-1-alice.eml',
    '60-attachment.eml',
    '12-order-3-alice-gmail.eml',
    '11-order-2-bob-outlook-en.eml',
].map(fixture);
const SUBJECTS_IN_ORDER = [
    'Office desks and chairs', // 10: 2025-03-03 09:15 +0100
    'RE: Office desks and chairs', // 11: 2025-03-03 14:02 +0100
    'Re: Office desks and chairs', // 12: 2025-03-03 15:40:12 +0100
    'RE: Office desks and chairs', // 13: 2025-03-06 16:20 +0100
    'Delivery note 2025-017', // 60: 2025-03-21 11:00 +0100
    'Spare chair', // 70: no date
];

test.use({ timezoneId: 'Africa/Lagos' });

let origin = '';
let watch: PageWatch;
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
        window.__previewViolations = [];
        document.addEventListener('securitypolicyviolation', (event) =>
        {
            // "select": WebKit's report about a <select> (see withoutSelectReports).
            window.__previewViolations.push(`${event.effectiveDirective} ${event.blockedURI}${event.target instanceof HTMLSelectElement ? ' select' : ''}`);
        });
    });
});

/** Opens the page, adds the fixtures and waits for the preview. */
async function openWithFixtures(page: Page): Promise<Locator>
{
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('#drop-zone')).toBeVisible();
    loadedAt = watch.requests.length;
    await page.locator('#file-input').setInputFiles(FILES);
    await expect(page.locator('#add-summary-text')).toHaveText('6 files added. 6 emails found.', { timeout: 30_000 });
    const items = page.locator('#preview-list > li');
    await expect(items).toHaveCount(6);
    await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/);
    // The PDF plans arrive a moment later and redraw the fold blocks (see
    // Source/web-page/pdf-labels.ts): wait for them, so no later click or focus is lost.
    await expect(page.locator('#preview-list')).toHaveAttribute('data-pdf-labels', 'ready', { timeout: 15_000 });
    return items;
}

/** Nothing left the page, no CSP violation, no console error (see add-files.spec.ts). */
async function expectNothingLeftThePage(page: Page): Promise<void>
{
    await page.waitForTimeout(500);
    const workerUrls = new Set(watch.workers.map((w) => w.url()));
    for (const url of workerUrls)
    {
        expect(url).toMatch(new RegExp(`^blob:${origin}/[0-9a-f-]+$`));
    }
    expect(watch.requests.slice(loadedAt).filter((url) => !workerUrls.has(url))).toEqual([]);
    expect(watch.requests.every((url) => new URL(url).origin === origin)).toBe(true);
    expect(watch.websockets).toEqual([]);
    const browserName = browserEngineOf(page.context());
    expect(withoutSelectReports(browserName, await page.evaluate(() => window.__previewViolations))).toEqual([]);
    expect(workerCspReports(watch)).toEqual([]);
    expect(withoutSelectConsole(browserName, problems)).toEqual([]);
}

test('lists the emails by date, with their details, in the browser zone', async ({ page }) =>
{
    test.setTimeout(60_000);
    const items = await openWithFixtures(page);

    await expect(page.locator('#preview-list')).toHaveAccessibleName(en.preview.listLabel);
    await expect(items.locator('.message-subject')).toHaveText(SUBJECTS_IN_ORDER);
    await expect(items.locator('.message-number')).toHaveText(['#1', '#2', '#3', '#4', '#5', '#6']);
    await expect(items.locator('h3')).toHaveCount(6);

    const zone = page.getByLabel(en.preview.zone);
    await expect(zone).toHaveValue('Africa/Lagos');
    await expect(items.nth(0).locator('.message-date')).toHaveText('2025-03-03 09:15:00 UTC+01:00');
    await expect(items.nth(0).locator('.sender-time')).toBeHidden();
    await expect(items.nth(0).locator('dd.meta-author')).toHaveText('Alice Example <alice@example.test>');
    await expect(items.nth(0).locator('dd.meta-to')).toHaveText('Bob Sample <bob@furniture.example.test>');
    await expect(items.nth(5).locator('.message-date')).toHaveText(en.preview.noDate);

    // The attachment is listed as text only: no link, nothing to open.
    await expect(items.nth(4).locator('.attachment')).toHaveText([/^delivery-note-2025-017\.txt \(\d+ bytes, text\/plain\)$/]);
    await expect(page.locator('#preview-list a, #preview-list img, #preview-list iframe, #preview-list object, #preview-list embed')).toHaveCount(0);

    await expectNothingLeftThePage(page);
});

test('changing the time zone changes the dates only', async ({ page }) =>
{
    test.setTimeout(60_000);
    const items = await openWithFixtures(page);
    // Marks a body element: if the bodies were rebuilt, the mark would be gone.
    await items.nth(1).locator('.message-body').evaluate((body) => body.setAttribute('data-test-mark', 'kept'));

    await page.getByLabel(en.preview.zone).selectOption('Asia/Tokyo');
    await expect(items.nth(0).locator('.message-date')).toHaveText('2025-03-03 17:15:00 UTC+09:00');
    await expect(items.nth(0).locator('.sender-time')).toHaveText("Sender's local time: 2025-03-03 09:15:00 UTC+01:00");
    await expect(items.nth(3).locator('.message-date')).toHaveText('2025-03-07 00:20:00 UTC+09:00');
    await expect(items.nth(5).locator('.message-date')).toHaveText(en.preview.noDate);
    await expect(items.nth(1).locator('.message-body')).toHaveAttribute('data-test-mark', 'kept');
    // The order does not depend on the zone.
    await expect(items.locator('.message-subject')).toHaveText(SUBJECTS_IN_ORDER);

    await page.getByLabel(en.preview.zone).selectOption('UTC');
    await expect(items.nth(0).locator('.message-date')).toHaveText('2025-03-03 08:15:00 UTC+00:00');

    await expectNothingLeftThePage(page);
});

test('quoted text is folded and can be shown, one block or all at once', async ({ page }) =>
{
    test.setTimeout(60_000);
    const items = await openWithFixtures(page);
    const reply = items.nth(1);
    const fold = reply.locator('details.fold').last();
    const quoted = fold.locator('.body-folded');

    // Bob's reply: his own words shown, Alice's quoted email folded with a label.
    await expect(reply.locator('.message-body > .body-text').first()).toContainText('I can come by on Wednesday 5 March');
    await expect(quoted).toBeHidden();
    await expect(fold.locator('summary')).toHaveText(/lines/);
    expect(await page.locator('details.fold').count()).toBeGreaterThan(2);

    // One block, with the keyboard.
    await fold.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(quoted).toBeVisible();
    await expect(quoted).toContainText('Someone is at the office');
    await page.keyboard.press('Enter');
    await expect(quoted).toBeHidden();

    // All blocks with the checkbox.
    const toggle = page.getByLabel(en.preview.showFolded);
    await toggle.check();
    const total = await page.locator('details.fold').count();
    await expect(page.locator('details.fold[open]')).toHaveCount(total);
    await expect(quoted).toBeVisible();

    // With everything shown, each email's whole text is in the page and visible
    // (README.md, rule R6): for these plain-text fixtures (7bit, no encoding),
    // the text blocks joined give back exactly the body written in the file.
    const joined = await items.evaluateAll((list) =>
        list.map((li) => [...li.querySelectorAll('.message-body .body-text')].map((b) => b.textContent).join('')),
    );
    expect(joined[0]).toBe(plainBody('10-order-1-alice.eml'));
    expect(joined[1]).toBe(plainBody('11-order-2-bob-outlook-en.eml'));
    for (const block of await page.locator('.message-body .body-text').all())
    {
        await expect(block).toBeVisible();
    }

    expect(await contrastFailures(page, '#step-check', 20)).toEqual([]);

    await toggle.uncheck();
    await expect(page.locator('details.fold[open]')).toHaveCount(0);
    await expect(quoted).toBeHidden();

    await expectNothingLeftThePage(page);
});

test('fits a narrow phone screen without sideways scrolling', async ({ page }) =>
{
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 320, height: 640 });
    await openWithFixtures(page);
    await page.getByLabel(en.preview.showFolded).check();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expectNothingLeftThePage(page);
});
