// Browser test of the cards of earlier emails rebuilt from quoted text in
// step 2 (milestone 7, task 7.6: src/ui/preview.ts, src/ui/review.ts,
// src/ui-model/rebuilt.ts), in each test browser against the BUILT site
// served by `vite preview` (see playwright.config.ts).
//
// The file added is the LAST email of a synthetic thread
// (tests/fixtures/eml/13-order-4-bob-outlook-nl.eml): its quote holds the
// three earlier emails, written by three mail programs (an Outlook block in
// Dutch, a Gmail ">" quote, an Outlook block in English inside it). Alone,
// it gives three rebuilt cards before its own card.
//
// Every test also checks, once everything has settled, that nothing left the
// page (only the inlined workers' blob: URLs), that there was no CSP
// violation (page or worker) and no console error. See e2e/support/watch.ts.
// The accessibility checks of this state are in e2e/accessibility.spec.ts.
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../src/ui/i18n/en.ts';
import { engineOf, watchPage, withoutSelectConsole, withoutSelectReports, workerCspReports, type Watch } from './support/watch.ts';

declare global
{
    interface Window {
        __rebuiltViolations: string[];
    }
}

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

/** Node's Buffer (see e2e/add-files.spec.ts): what setInputFiles wants for in-memory files. */
const NodeBuffer = (globalThis as unknown as { Buffer: { from(bytes: Uint8Array): Uint8Array } }).Buffer;

/** A fixture as an in-memory file (the fixtures are 7-bit ASCII text). */
const fixture = (name: string): { name: string; mimeType: string; buffer: never } => ({
    name,
    mimeType: 'message/rfc822',
    buffer: NodeBuffer.from(new TextEncoder().encode(readFileSync(`${ROOT}tests/fixtures/eml/${name}`, 'utf8'))) as never,
});

const LAST = fixture('13-order-4-bob-outlook-nl.eml');

/** The fixed notes, as the cards show them (source email #1). */
const NOTE_MARKS = en.rebuilt.noteMarks.replace('{number}', '#1');
const NOTE_NO_MARKS = en.rebuilt.noteNoMarks.replace('{number}', '#1');

test.use({ timezoneId: 'Africa/Lagos' });

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
        if (message.type() === 'error') problems.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    await page.addInitScript(() =>
    {
        window.__rebuiltViolations = [];
        document.addEventListener('securitypolicyviolation', (event) =>
        {
            // "select": WebKit's report about a <select> (see withoutSelectReports).
            window.__rebuiltViolations.push(`${event.effectiveDirective} ${event.blockedURI}${event.target instanceof HTMLSelectElement ? ' select' : ''}`);
        });
    });
});

/** Opens the page, adds the last email of the thread and waits for the whole list. */
async function openWithLastEmail(page: Page): Promise<Locator>
{
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('#drop-zone')).toBeVisible();
    loadedAt = watch.requests.length;
    await page.locator('#file-input').setInputFiles([LAST]);
    await expect(page.locator('#add-summary-text')).toHaveText('1 file added. 1 email found.', { timeout: 30_000 });
    const items = page.locator('#preview-list > li');
    await expect(items).toHaveCount(4);
    await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/);
    return items;
}

/** Nothing left the page, no CSP violation, no console error (see e2e/review.spec.ts). */
async function expectNothingLeftThePage(page: Page): Promise<void>
{
    await page.waitForTimeout(500);
    const workerUrls = new Set(watch.workers.map((w) => w.url()));
    for (const url of workerUrls) expect(url).toMatch(new RegExp(`^blob:${origin}/[0-9a-f-]+$`));
    expect(watch.requests.slice(loadedAt).filter((url) => !workerUrls.has(url))).toEqual([]);
    expect(watch.requests.every((url) => new URL(url).origin === origin)).toBe(true);
    expect(watch.websockets).toEqual([]);
    const browserName = engineOf(page.context());
    expect(withoutSelectReports(browserName, await page.evaluate(() => window.__rebuiltViolations))).toEqual([]);
    expect(workerCspReports(watch)).toEqual([]);
    expect(withoutSelectConsole(browserName, problems)).toEqual([]);
}

test('by default, rebuilt cards appear before the email they come from, labelled, with their note and no number', async ({ page }) =>
{
    test.setTimeout(60_000);
    const items = await openWithLastEmail(page);
    const rebuilt = page.locator('#preview-list > li.message-rebuilt');
    await expect(rebuilt).toHaveCount(3);
    // Oldest first, then the email that was added (the only one with a number).
    await expect(items.nth(3)).not.toHaveClass(/message-rebuilt/);
    await expect(items.locator('.message-number')).toHaveText(['#1']);
    await expect(rebuilt.locator('.message-number')).toHaveCount(0);
    // The word, not only the dashed border.
    await expect(rebuilt.locator('h3 .rebuilt-label')).toHaveText([en.rebuilt.label, en.rebuilt.label, en.rebuilt.label]);
    await expect(rebuilt.nth(0)).toHaveCSS('border-top-style', 'dashed');
    await expect(rebuilt.locator('.rebuilt-note')).toHaveText([NOTE_MARKS, NOTE_MARKS, NOTE_NO_MARKS]);
    await expect(rebuilt.locator('dd.meta-source')).toHaveText(['email #1', 'email #1', 'email #1']);
    // The newest quoted email: an Outlook block in Dutch; its date is a guess ("about"), shown as written too.
    const newest = rebuilt.nth(2);
    await expect(newest.locator('.message-subject')).toHaveText('Re: Office desks and chairs');
    await expect(newest.locator('dd.meta-author')).toHaveText('Alice Example <alice@example.test>');
    await expect(newest.locator('dd.meta-date')).toHaveText(/^about 2025-03-03 \d\d:40 UTC\+01:00 As written in the quote: maandag 3 maart 2025 15:40$/);
    // The Gmail quote: no subject in an attribution line, and its text without the ">" marks.
    const gmail = rebuilt.nth(1);
    await expect(gmail.locator('.message-subject')).toHaveText(en.rebuilt.noSubject);
    const text = (await gmail.locator('.body-text').textContent()) ?? '';
    expect(text).toContain('Thank you for your message.');
    expect(text).not.toMatch(/^>/m);
    // The email added keeps all its text, quotes included (folded, one click away).
    const source = items.nth(3);
    await expect(source.locator('.message-body')).toContainText('Thank you for your message.');
    // Counts and the switch.
    await expect(page.locator('#review-messages')).toHaveText('1 email found, 3 earlier emails rebuilt from quoted text.');
    await expect(page.locator('#review-rebuilt')).toHaveText('3 of 3 rebuilt emails will be in the PDF.');
    await expect(page.locator('#review-included')).toHaveText('1 of 1 email will be in the PDF.');
    const all = page.getByRole('checkbox', { name: en.rebuilt.rebuildConversation });
    await expect(all).toBeVisible();
    await expect(all).toBeChecked();
    for (const box of await rebuilt.getByRole('checkbox').all())
    {
        await expect(box).toBeChecked();
        await expect(box).toHaveAccessibleName(new RegExp(`^${en.actions.include} ${en.rebuilt.label} \\S`));
    }
    await expectNothingLeftThePage(page);
});

test('the switch leaves every rebuilt email out, with the keyboard, and brings them back', async ({ page }) =>
{
    test.setTimeout(60_000);
    const items = await openWithLastEmail(page);
    const all = page.locator('#rebuilt-include-all');
    await all.focus();
    await page.keyboard.press('Space');
    await expect(all).not.toBeChecked();
    await expect(page.locator('#preview-list > li.message-rebuilt')).toHaveCount(3);
    for (const card of await page.locator('#preview-list > li.message-rebuilt').all()) await expect(card).toBeHidden();
    await expect(items.filter({ visible: true })).toHaveCount(1);
    // Off: the counts do not mention rebuilt emails at all.
    await expect(page.locator('#review-rebuilt')).toBeHidden();
    await expect(page.locator('#review-messages')).toHaveText('1 email found.');
    // The emails line is announced instead, through the page's one live region (no older rebuilt line stays).
    await expect(page.getByRole('status')).toHaveText('1 of 1 email will be in the PDF.');
    await expect(all).toBeFocused();
    // The next Tab stop is the added email's own checkbox: no hidden card is reached.
    await page.keyboard.press('Tab');
    await expect(page.locator('#include-0')).toBeFocused();

    await all.focus();
    await page.keyboard.press('Space');
    await expect(all).toBeChecked();
    await expect(items.filter({ visible: true })).toHaveCount(4);
    await expect(page.locator('#review-rebuilt')).toHaveText('3 of 3 rebuilt emails will be in the PDF.');
    await expect(page.locator('#review-messages')).toHaveText('1 email found, 3 earlier emails rebuilt from quoted text.');
    await expect(page.getByRole('status')).toHaveText('3 of 3 rebuilt emails will be in the PDF.');
    await expectNothingLeftThePage(page);
});

test('the keyboard goes through the toolbar, then each card in list order; a card unticked stays, marked', async ({ page }) =>
{
    test.setTimeout(60_000);
    await openWithLastEmail(page);
    await page.locator('#preview-zone').focus();
    const order: string[] = [];
    for (let i = 0; i < 7; i++)
    {
        await page.keyboard.press('Tab');
        order.push(await page.evaluate(() => document.activeElement?.id ?? ''));
    }
    expect(order).toEqual(['preview-show-folded', 'pdf-everything', 'rebuilt-include-all', 'include-rebuilt-2', 'include-rebuilt-1', 'include-rebuilt-0', 'include-0']);

    const card = page.locator('#preview-list > li.message-rebuilt').nth(1);
    await card.getByRole('checkbox').focus();
    await page.keyboard.press('Space');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-included', 'false');
    await expect(card.locator('.excluded-note')).toHaveText(en.review.excluded);
    await expect(page.locator('#review-rebuilt')).toHaveText('2 of 3 rebuilt emails will be in the PDF.');
    await expect(page.locator('#review-included')).toHaveText('1 of 1 email will be in the PDF.');

    // "Clear everything" forgets the choices: the same file again shows every card ticked.
    await page.locator('#clear-everything').click();
    await expect(page.locator('#preview-list > li')).toHaveCount(0);
    await page.locator('#file-input').setInputFiles([LAST]);
    await expect(page.locator('#preview-list > li')).toHaveCount(4, { timeout: 30_000 });
    await expect(page.locator('#review-rebuilt')).toHaveText('3 of 3 rebuilt emails will be in the PDF.');
    await expectNothingLeftThePage(page);
});

test('no rebuilt card and no switch when every quoted email was added as a file (the real file wins)', async ({ page }) =>
{
    test.setTimeout(60_000);
    await page.goto('/', { waitUntil: 'networkidle' });
    loadedAt = watch.requests.length;
    const files = ['10-order-1-alice.eml', '11-order-2-bob-outlook-en.eml', '12-order-3-alice-gmail.eml', '13-order-4-bob-outlook-nl.eml'].map(fixture);
    await page.locator('#file-input').setInputFiles(files);
    await expect(page.locator('#preview-list > li')).toHaveCount(4, { timeout: 30_000 });
    await expect(page.locator('#preview-list > li.message-rebuilt')).toHaveCount(0);
    await expect(page.locator('#rebuilt-switch')).toBeHidden();
    await expect(page.locator('#review-rebuilt')).toBeHidden();
    await expect(page.locator('#review-messages')).toHaveText('4 emails found.');
    await expectNothingLeftThePage(page);
});

test('the cards follow the page language', async ({ page }) =>
{
    test.setTimeout(60_000);
    await openWithLastEmail(page);
    await page.locator('#lang-fr').check();
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.locator('#preview-list > li.message-rebuilt h3 .rebuilt-label').first()).toHaveText('Reconstitu\u00E9');
    await expect(page.locator('#preview-list > li.message-rebuilt .rebuilt-note').first()).toContainText('Reconstitu\u00E9 \u00E0 partir du texte cit\u00E9');
    await expectNothingLeftThePage(page);
});
