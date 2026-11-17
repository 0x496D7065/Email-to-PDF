// Browser test of step 2's counts, include checkboxes and notes
// (Source/page/review.ts; README.md, rules R1, R2, R4, R5 and R6), in each test
// browser against the BUILT site served by `vite preview` (see playwright.config.ts).
// The real pipeline runs on synthetic fixtures from tests/fixtures/eml plus
// one made-up file that is not an email, added through the file input.
//
// Every test also checks, once everything has settled, that nothing left the
// page (only the inlined workers' blob: URLs), that there was no CSP
// violation (page or worker) and no console error. See e2e/support/watch.ts.
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../Source/page/translations/en.ts';
import { contrastFailures } from './support/contrast.ts';
import { engineOf, watchPage, withoutSelectConsole, withoutSelectReports, workerCspReports, type Watch } from './support/watch.ts';

declare global
{
    interface Window
    {
        __reviewViolations: string[];
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

// 7 email files (one is an identical copy of another) and one file that is not an email.
const FILES = [
    fixture('13-order-4-bob-outlook-nl.eml'),
    fixture('70-no-date.eml'),
    fixture('10-order-1-alice.eml'),
    fixture('30-dup-order-2-copy.eml'),
    fixture('60-attachment.eml'),
    fixture('12-order-3-alice-gmail.eml'),
    fixture('11-order-2-bob-outlook-en.eml'),
    { name: 'notes.txt', mimeType: 'text/plain', buffer: NodeBuffer.from(new TextEncoder().encode('Order notes, not an email.')) as never },
];

test.use({ timezoneId: 'America/New_York' });

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
        window.__reviewViolations = [];
        document.addEventListener('securitypolicyviolation', (event) =>
        {
            // "select": WebKit's report about a <select> (see withoutSelectReports).
            window.__reviewViolations.push(`${event.effectiveDirective} ${event.blockedURI}${event.target instanceof HTMLSelectElement ? ' select' : ''}`);
        });
    });
});

/** Opens the page, adds the files and waits for the whole list. */
async function openWithFiles(page: Page): Promise<Locator>
{
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('#drop-zone')).toBeVisible();
    loadedAt = watch.requests.length;
    await page.locator('#file-input').setInputFiles(FILES);
    await expect(page.locator('#add-summary-text')).toHaveText('8 files added. 1 could not be read. 7 emails found. 1 identical copy merged.', {
        timeout: 30_000,
    });
    const items = page.locator('#preview-list > li');
    await expect(items).toHaveCount(6);
    await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/);
    return items;
}

/** Nothing left the page, no CSP violation, no console error (see e2e/preview.spec.ts). */
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
    const browserName = engineOf(page.context());
    expect(withoutSelectReports(browserName, await page.evaluate(() => window.__reviewViolations))).toEqual([]);
    expect(workerCspReports(watch)).toEqual([]);
    expect(withoutSelectConsole(browserName, problems)).toEqual([]);
}

test('shows the counts, and points to step 1 for the file that could not be read', async ({ page }) =>
{
    test.setTimeout(60_000);
    await openWithFiles(page);
    const summary = page.locator('#review-summary');
    await expect(summary).toBeVisible();
    await expect(page.locator('#review-files')).toHaveText(`8 files, 1 could not be read. ${en.counts.seeFailed}`);
    await expect(page.locator('#review-messages')).toHaveText('7 emails found, 1 identical copy merged.');
    await expect(page.locator('#review-included')).toHaveText('6 of 6 emails will be in the PDF.');
    await expect(page.locator('#review-notes')).toHaveText(/^\d+ emails? ha(s|ve) notes/);

    // The reasons are in step 1's list (one list only, pointed to from here).
    await expect(page.locator('#add-failed-list > li .failed-reason')).toHaveText([`notes.txt ${en.errors.file['unsupported-type']}`]);
    await expectNothingLeftThePage(page);
});

test('unticking an email leaves it in the list, dimmed, with its text; the count follows', async ({ page }) =>
{
    test.setTimeout(60_000);
    const items = await openWithFiles(page);
    const boxes = page.getByRole('checkbox', { name: en.actions.include });
    await expect(boxes).toHaveCount(6);
    for (const box of await boxes.all())
    {
        await expect(box).toBeChecked();
    }

    const second = items.nth(1);
    const box = second.getByRole('checkbox', { name: en.actions.include });
    // Named by its label and the email's heading, so each checkbox says which email it is for.
    await expect(box).toHaveAccessibleName(`${en.actions.include} #2 RE: Office desks and chairs`);
    await box.focus();
    await page.keyboard.press('Space');
    await expect(box).not.toBeChecked();
    await expect(page.locator('#review-included')).toHaveText('5 of 6 emails will be in the PDF.');
    // Announced through the page's one live region.
    await expect(page.getByRole('status')).toHaveText('5 of 6 emails will be in the PDF.');
    await expect(second).toHaveAttribute('data-included', 'false');
    await expect(second.locator('.excluded-note')).toHaveText(en.review.excluded);
    await expect(second.locator('.excluded-note')).toBeVisible();
    // Still there, text and all (README.md, rule R6).
    await expect(items).toHaveCount(6);
    await expect(second.locator('.message-subject')).toHaveText('RE: Office desks and chairs');
    await expect(second.locator('.message-body > .body-text').first()).toContainText('I can come by on Wednesday 5 March');
    await expect(second.locator('.message-body > .body-text').first()).toBeVisible();
    // The dimmed email, with its folded text shown, still meets the contrast rules.
    await page.getByLabel(en.preview.showFolded).check();
    expect(await contrastFailures(page, '#step-check', 20)).toEqual([]);

    await box.check();
    await expect(page.locator('#review-included')).toHaveText('6 of 6 emails will be in the PDF.');
    await expect(second).toHaveAttribute('data-included', 'true');
    await expect(second.locator('.excluded-note')).toBeHidden();
    await expectNothingLeftThePage(page);
});

test('the undated email shows its notes; the choices survive adding another file', async ({ page }) =>
{
    test.setTimeout(90_000);
    const items = await openWithFiles(page);
    const undated = items.nth(5);
    await expect(undated.locator('.message-subject')).toHaveText('Spare chair');
    const notes = undated.getByRole('list', { name: en.review.notesLabel }).locator('li');
    await expect(notes.nth(0)).toHaveText(en.warnings.parse['missing-date']);
    await expect(notes.nth(1)).toHaveText(en.preview.order['file-order']);

    await undated.getByRole('checkbox', { name: en.actions.include }).uncheck();
    await expect(page.locator('#review-included')).toHaveText('5 of 6 emails will be in the PDF.');

    // One more file: the whole set is read again; the undated email stays unticked.
    await page.locator('#file-input').setInputFiles([fixture('01-plain-english.eml')]);
    await expect(page.locator('#add-summary-text')).toHaveText('9 files added. 1 could not be read. 8 emails found. 1 identical copy merged.', {
        timeout: 30_000,
    });
    await expect(items).toHaveCount(7);
    await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/);
    await expect(page.locator('#review-included')).toHaveText('6 of 7 emails will be in the PDF.');
    const stillUndated = items.nth(6);
    await expect(stillUndated.locator('.message-subject')).toHaveText('Spare chair');
    await expect(stillUndated.getByRole('checkbox', { name: en.actions.include })).not.toBeChecked();
    await expect(page.locator('#preview-list > li[data-included="false"]')).toHaveCount(1);
    await expectNothingLeftThePage(page);
});

test('task 8.8: what the PDF no longer says is shown in step 2 before the download', async ({ page }) =>
{
    test.setTimeout(60_000);
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('#drop-zone')).toBeVisible();
    loadedAt = watch.requests.length;
    await page
        .locator('#file-input')
        .setInputFiles([
            fixture('71-bad-date.eml'),
            fixture('73-date-no-zone.eml'),
            fixture('93-answers-between-lines.eml'),
            fixture('11-order-2-bob-outlook-en.eml'),
            fixture('30-dup-order-2-copy.eml'),
            { name: 'notes.txt', mimeType: 'text/plain', buffer: NodeBuffer.from(new TextEncoder().encode('Order notes, not an email.')) as never },
        ]);
    await expect(page.locator('#add-summary-text')).toHaveText('6 files added. 1 could not be read. 5 emails found. 1 identical copy merged.', { timeout: 30_000 });
    await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/);
    const card = (subject: string): Locator =>
        page.locator('#preview-list > li.message:not(.message-rebuilt)').filter({ has: page.locator('.message-subject', { hasText: subject }) });
    const notesOf = (subject: string): Locator => card(subject).getByRole('list', { name: en.review.notesLabel }).locator('li');

    // The file that could not be read: in step 1 with its reason, counted in step 2.
    await expect(page.locator('#add-failed-list > li .failed-reason')).toHaveText([`notes.txt ${en.errors.file['unsupported-type']}`]);
    await expect(page.locator('#review-files')).toHaveText(`6 files, 1 could not be read. ${en.counts.seeFailed}`);
    // Two files with the same email, merged: counted, and the card names the other file.
    await expect(page.locator('#review-messages')).toHaveText(/^5 emails found, 1 identical copy merged/);
    await expect(card('RE: Office desks and chairs').locator('dd.meta-also-in')).toHaveText('30-dup-order-2-copy.eml');
    // A date that could not be read: "(no date)", the date as written, why, and where it is placed.
    await expect(card('Cable trays').locator('dd.meta-date')).toHaveText(`${en.preview.noDate} As written in the email: not a date`);
    await expect(notesOf('Cable trays')).toHaveText([en.warnings.parse['unparseable-date'], en.preview.order['file-order']]);
    // The sender's time zone not given.
    await expect(notesOf('Old desks')).toHaveText([en.warnings.parse['unknown-time-zone']]);
    // A control character (a BEL) the PDF shows as a code.
    await expect(notesOf('Answers between the lines')).toContainText([en.review.codedCharacters]);
    // What rebuilt emails are, under the switch, read as its description.
    const rebuild = page.getByRole('checkbox', { name: en.rebuilt.rebuildConversation });
    await expect(rebuild).toBeVisible();
    await expect(page.locator('#rebuilt-explain')).toHaveText(en.rebuilt.explain);
    await expect(page.locator('#rebuilt-explain')).toBeVisible();
    await expect(rebuild).toHaveAccessibleDescription(en.rebuilt.explain);
    // A zone the browser knows: no zone note.
    await expect(page.locator('#preview-zone-note')).toBeHidden();
    // Calm and readable: the new texts meet the contrast rules.
    expect(await contrastFailures(page, '#step-check', 20)).toEqual([]);
    await expectNothingLeftThePage(page);
});
