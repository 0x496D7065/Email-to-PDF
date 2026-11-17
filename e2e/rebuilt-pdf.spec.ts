// Browser test of the emails rebuilt from quoted text IN THE PDF (milestone
// 7, task 7.7, and task 8.3: src/pdf/model.ts, src/ui/review.ts,
// src/ui/page.ts), in each
// test browser against the BUILT site served by `vite preview` (see
// playwright.config.ts), with the real pipeline and the real workers. The
// downloaded file is read back as text (tests/support/pdf-reader.ts: the
// glyphs through ToUnicode, what a reader sees).
//
// The file added is the LAST email of a synthetic thread
// (tests/fixtures/eml/13-order-4-bob-outlook-nl.eml): alone, it gives three
// rebuilt cards before its own (e2e/rebuilt.spec.ts checks the cards).
// 1. By default, the three rebuilt emails are in the PDF, shown and
//    numbered exactly like real emails (user decision 2026-11-02, task 8.3:
//    emails 1 to 4, nothing saying they were rebuilt: no marker, no note,
//    no "Taken from" row, no cover count or section); the cover counts 4
//    emails; no source file list and no SHA-256, the index right after the
//    People list on the cover page (task 8.12).
// 2. The switch off: only the real email, as email 1.
// 3. The email they were taken from unticked (another email added, so a
//    PDF can still be made): the cards are marked "Not in the PDF", and
//    nothing rebuilt is in the PDF (user decision Q1 (a)).
// 4. "Print full original text" ticked (user decision 2026-10-29, task
//    7.8c): its note is shown and read with it, the "Rebuild conversation
//    from replies" switch is unticked and disabled (with a short accessible
//    reason), no rebuilt card is shown, the keyboard skips the switch, the
//    PDF holds the email whole (each quoted text once) and nothing rebuilt;
//    unticked, the switch and every card's tick come back exactly, also
//    when the switch was off before (it stays off).
// 5. That note and the disabled switch at 320 px wide and at 200% zoom:
//    they wrap, no sideways scrolling.
//
// Throughout (see e2e/support/watch.ts): after the page's own files, only
// the own-origin blob: URLs of the inlined workers and, at most once, the
// PDF's; no WebSocket, no CSP violation in the page or a worker, no console
// error, nothing stored. Test data is made up (README.md, rule R7).
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/ui/i18n/en.ts';
import { readPageRuns, readPdf, textLines } from '../tests/support/pdf-reader.ts';
import { engineOf, watchPage, withoutSelectConsole, withoutSelectReports, workerCspReports, type Watch } from './support/watch.ts';

declare global
{
    interface Window {
        __rebuiltPdfViolations: string[];
    }
}

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

/** Node's Buffer (see e2e/add-files.spec.ts): what setInputFiles wants for in-memory files. */
const NodeBuffer = (globalThis as unknown as { Buffer: { from(bytes: Uint8Array): Uint8Array } }).Buffer;

/** A fixture as an in-memory file (the fixtures are 7-bit ASCII text), and its bytes. */
const fixture = (name: string): { name: string; mimeType: string; buffer: never } => ({
    name,
    mimeType: 'message/rfc822',
    buffer: NodeBuffer.from(new TextEncoder().encode(readFileSync(`${ROOT}tests/fixtures/eml/${name}`, 'utf8'))) as never,
});

const LAST = fixture('13-order-4-bob-outlook-nl.eml');
/** An email of another conversation, with nothing quoted: no rebuilt email of its own. */
const OTHER = fixture('70-no-date.eml');

/** "Email N": the heading of every email in the PDF, rebuilt ones too (task 8.3). */
const heading = (n: number): string => en.pdf.document.emailHeading.replace('{number}', String(n));

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
        if (message.type() === 'error')
        {
            problems.push(`console: ${message.text()}`);
        }
    });
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    await page.addInitScript(() =>
    {
        window.__rebuiltPdfViolations = [];
        document.addEventListener('securitypolicyviolation', (event) =>
        {
            // "select": WebKit's report about a <select> (see withoutSelectReports).
            window.__rebuiltPdfViolations.push(`${event.effectiveDirective} ${event.blockedURI}${event.target instanceof HTMLSelectElement ? ' select' : ''}`);
        });
    });
});

const makeButton = (page: Page) => page.getByRole('button', { name: en.actions.makePdf });

/** Opens the page, adds the files and waits for the whole list (`items` cards and emails). */
async function open(page: Page, files: ReturnType<typeof fixture>[], items: number): Promise<void>
{
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('#drop-zone')).toBeVisible();
    loadedAt = watch.requests.length;
    await page.locator('#file-input').setInputFiles(files);
    await expect(page.locator('#preview-list > li')).toHaveCount(items, { timeout: 30_000 });
    await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/);
}

/** Presses "Make the PDF" once it is available and returns the PDF's text: one string per page, lines joined by spaces. */
async function makePdfText(page: Page): Promise<string[]>
{
    await expect(makeButton(page)).not.toHaveAttribute('aria-disabled', /.*/, { timeout: 60_000 });
    const next = page.waitForEvent('download', { timeout: 60_000 });
    await makeButton(page).click();
    const download = await next;
    const bytes = new Uint8Array(readFileSync(await download.path()));
    const pages = await readPageRuns(readPdf(bytes));
    return pages.map((runs) => textLines(runs).map((l) => l.shown).join(' '));
}

/** Nothing left the page but the workers and (at most `pdfs` times) the PDF, no CSP violation, no console error, nothing stored. */
async function expectNothingLeftThePage(page: Page, pdfs = 1): Promise<void>
{
    await page.waitForTimeout(500);
    const ownBlob = new RegExp(`^blob:${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[0-9a-f-]+$`);
    const workerUrls = new Set(watch.workers.map((w) => w.url()));
    for (const url of workerUrls)
    {
        expect(url).toMatch(ownBlob);
    }
    // The PDFs' own blob: URLs (Chromium may list a blob: download as a request), nothing else.
    const others = watch.requests.slice(loadedAt).filter((url) => !workerUrls.has(url));
    expect(others.length).toBeLessThanOrEqual(pdfs);
    for (const url of others)
    {
        expect(url).toMatch(ownBlob);
    }
    expect(watch.requests.every((url) => url.startsWith('blob:') || new URL(url).origin === origin)).toBe(true);
    expect(watch.websockets).toEqual([]);
    const browserName = engineOf(page.context());
    expect(withoutSelectReports(browserName, await page.evaluate(() => window.__rebuiltPdfViolations))).toEqual([]);
    expect(workerCspReports(watch)).toEqual([]);
    expect(withoutSelectConsole(browserName, problems)).toEqual([]);
    const stored = await page.evaluate(async () => ({
        localStorage: localStorage.length,
        sessionStorage: sessionStorage.length,
        indexedDB: (await indexedDB.databases()).length,
        cookie: document.cookie,
    }));
    expect(stored).toEqual({ localStorage: 0, sessionStorage: 0, indexedDB: 0, cookie: '' });
}

test('by default the PDF holds the three rebuilt emails, shown and numbered like real emails, before the email they were taken from', async ({ page }) =>
{
    test.setTimeout(90_000);
    await open(page, [LAST], 4);
    await expect(page.locator('#review-rebuilt')).toHaveText('3 of 3 rebuilt emails will be in the PDF.');
    const pages = await makePdfText(page);
    const all = pages.join(' ');
    // The cover: all four emails counted, nothing about rebuilt emails.
    expect(pages[0]).toContain('Emails 4 emails');
    // No source files (task 8.12): after the People list comes the index, on the same page; no file name before the emails.
    expect(pages[0]).toMatch(new RegExp(`${en.pdf.document.people} • .+ ${en.pdf.document.index} ${en.pdf.document.column.number} `));
    expect(pages[0]).not.toContain('Source files');
    expect(pages[0]).not.toContain(LAST.name);
    expect(all).not.toContain('SHA-256 fingerprint');
    // Nothing in the PDF says an email was rebuilt (the real email's text has no such word either).
    expect(all).not.toMatch(/rebuilt/i);
    expect(all).not.toContain('Taken from');
    expect(all).not.toContain(en.rebuilt.noteNoMarks.replace('{number}', '1'));
    expect(all).not.toContain(en.rebuilt.noteMarks.replace('{number}', '1'));
    expect(all).not.toContain('As written in the quote');
    // The index (on the cover page) lists the rebuilt ones too.
    expect(pages[0]).toContain('Re: Office desks and chairs');
    // Emails 1 to 4 in timeline order: the three rebuilt ones, then the email added.
    for (const n of [1, 2, 3, 4])
    {
        expect(all.split(`${heading(n)} From`), heading(n)).toHaveLength(2);
    }
    expect(all.indexOf(`${heading(3)} From`)).toBeLessThan(all.indexOf(`${heading(4)} From`));
    // A quoted time is shown as a real email's date (no "about").
    expect(all).toMatch(/Date 2025-03-03 \d\d:40:00 UTC\+01:00/);
    expect(all).not.toMatch(/Date about/);
    // No SHA-256 at all (task 8.12).
    expect(all).not.toMatch(/\b[0-9a-f]{64}\b/);
    await expectNothingLeftThePage(page);
});

test('the switch off: nothing rebuilt in the PDF, the real email is email 1', async ({ page }) =>
{
    test.setTimeout(90_000);
    await open(page, [LAST], 4);
    await page.getByRole('checkbox', { name: en.rebuilt.rebuildConversation }).uncheck();
    await expect(page.locator('#review-rebuilt')).toBeHidden();
    await expect(page.locator('#review-messages')).toHaveText('1 email found.');
    const all = (await makePdfText(page)).join(' ');
    expect(all).toContain('Email 1');
    expect(all).toContain('Emails 1 email');
    expect(all).not.toContain(heading(2));
    expect(all).not.toMatch(/rebuilt/i);
    await expectNothingLeftThePage(page);
});

test('the email they were taken from unticked: the cards say so, and nothing rebuilt is in the PDF', async ({ page }) =>
{
    test.setTimeout(90_000);
    await open(page, [OTHER, LAST], 5);
    const source = page.locator('#preview-list > li:not(.message-rebuilt)').filter({ hasText: 'RE: Office desks and chairs' });
    await source.getByRole('checkbox', { name: en.actions.include }).uncheck();
    await expect(page.locator('#review-rebuilt')).toHaveText('0 of 3 rebuilt emails will be in the PDF.');
    const cards = page.locator('#preview-list > li.message-rebuilt');
    for (const card of await cards.all())
    {
        await expect(card).toBeVisible();
        await expect(card).toHaveAttribute('data-included', 'false');
        await expect(card.locator('.excluded-note')).toHaveText(en.rebuilt.sourceExcluded);
        // Its own tick is kept.
        await expect(card.getByRole('checkbox')).toBeChecked();
    }
    const all = (await makePdfText(page)).join(' ');
    expect(all).toContain('Email 1');
    expect(all).not.toContain('Email 2');
    expect(all).not.toMatch(/rebuilt/i);
    expect(all).not.toContain('Office desks and chairs');
    // Ticked again: the rebuilt emails come back, numbered with the others: the three rebuilt
    // ones and their source are emails 1 to 4, the undated email comes last (email 5).
    await source.getByRole('checkbox', { name: en.actions.include }).check();
    await expect(page.locator('#review-rebuilt')).toHaveText('3 of 3 rebuilt emails will be in the PDF.');
    const again = (await makePdfText(page)).join(' ');
    expect(again).toContain('Emails 5 emails');
    expect(again).toContain(`${heading(5)} From`);
    expect(again).not.toContain(heading(6));
    expect(again).not.toMatch(/rebuilt/i);
    await expectNothingLeftThePage(page, 2);
});

test('"Print full original text" ticked: the switch is unticked and disabled, no rebuilt card, the PDF holds the email whole with nothing rebuilt; unticked: back exactly (task 7.8c)', async ({ page }) =>
{
    test.setTimeout(120_000);
    await open(page, [LAST], 4);
    const everything = page.getByRole('checkbox', { name: en.pdf.everything });
    const note = page.locator('#pdf-everything-note');
    const rebuild = page.getByRole('checkbox', { name: en.rebuilt.rebuildConversation });
    const hint = page.locator('#rebuilt-off-hint');
    // The note is always there, read with the checkbox.
    await expect(note).toBeVisible();
    await expect(note).toHaveText(en.pdf.everythingNote);
    await expect(everything).toHaveAttribute('aria-describedby', 'pdf-everything-note');
    await expect(everything).toHaveAccessibleDescription(en.pdf.everythingNote);
    // The switch: on, usable, no description; its hint is never shown.
    await expect(rebuild).toBeChecked();
    await expect(rebuild).toBeEnabled();
    await expect(rebuild).toHaveAccessibleDescription(en.rebuilt.explain);
    await expect(hint).toBeHidden();
    const cards = page.locator('#preview-list > li.message-rebuilt');
    const source = page.locator('#preview-list > li:not(.message-rebuilt)');
    // One card unticked first: the state to come back to.
    await cards.first().getByRole('checkbox').uncheck();
    await expect(page.locator('#review-rebuilt')).toHaveText('2 of 3 rebuilt emails will be in the PDF.');

    await everything.check();
    // Rebuilt emails are then not mentioned at all: no rebuilt line, no rebuilt part in the counts, nothing announced about them.
    await expect(page.locator('#review-rebuilt')).toBeHidden();
    await expect(page.locator('#review-messages')).toHaveText('1 email found.');
    await expect(page.locator('#status')).not.toContainText('rebuilt');
    await expect(page.locator('#status')).toContainText('1 of 1 email will be in the PDF.');
    // The switch: unticked, disabled (also for assistive technology), with a short reason.
    await expect(rebuild).not.toBeChecked();
    await expect(rebuild).toBeDisabled();
    await expect(rebuild).toHaveAttribute('aria-describedby', 'rebuilt-off-hint rebuilt-explain');
    await expect(rebuild).toHaveAccessibleDescription(`${en.rebuilt.offWhileFullText} ${en.rebuilt.explain}`);
    await expect(hint).toBeHidden();
    // No rebuilt card is shown: exactly as with the switch off (no dimmed card left behind).
    await expect(cards).toHaveCount(3);
    for (const card of await cards.all())
    {
        await expect(card).toBeHidden();
    }
    await expect(page.locator('#preview-list > li').filter({ visible: true })).toHaveCount(1);
    // The email added keeps all its text: its quoted history is still there, folded, one click away.
    await expect(source).toBeVisible();
    await expect(source.locator('.fold').first()).toBeAttached();
    await expect(source.locator('.message-body')).toContainText('Wednesday at 10:00 works for me.');
    // The keyboard skips the disabled switch and the hidden cards.
    await everything.focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#include-0')).toBeFocused();
    const all = (await makePdfText(page)).join(' ');
    expect(all).toContain('Email 1');
    expect(all).not.toContain(heading(2));
    expect(all).not.toMatch(/rebuilt/i);
    // The source email is printed whole: its quoted history (the earlier emails' text) is in, once each.
    for (const quoted of ['Wednesday at 10:00 works for me.', 'I can come by on Wednesday 5 March', 'We are furnishing a small office'])
    {
        expect(all.split(quoted), quoted).toHaveLength(2);
    }
    // No source file list and no SHA-256 in this mode either (task 8.12).
    expect(all).not.toMatch(/\b[0-9a-f]{64}\b/);
    expect(all).not.toContain('Source files');

    await everything.uncheck();
    await expect(page.locator('#review-rebuilt')).toHaveText('2 of 3 rebuilt emails will be in the PDF.');
    await expect(page.locator('#review-messages')).toHaveText('1 email found, 3 earlier emails rebuilt from quoted text.');
    await expect(rebuild).toBeChecked();
    await expect(rebuild).toBeEnabled();
    await expect(rebuild).toHaveAccessibleDescription(en.rebuilt.explain);
    const ticks = [false, true, true];
    for (const [k, card] of (await cards.all()).entries())
    {
        await expect(card).toBeVisible();
        await expect(card.getByRole('checkbox')).toBeChecked({ checked: ticks[k]! });
        await expect(card).toHaveAttribute('data-included', ticks[k]! ? 'true' : 'false');
    }
    // The switch is a Tab stop again, right after the full-text checkbox.
    await everything.focus();
    await page.keyboard.press('Tab');
    await expect(rebuild).toBeFocused();
    const again = (await makePdfText(page)).join(' ');
    // Two rebuilt emails and the email added: emails 1 to 3.
    expect(again).toContain('Emails 3 emails');
    expect(again).toContain(`${heading(3)} From`);
    expect(again).not.toContain(heading(4));
    expect(again).not.toMatch(/rebuilt/i);
    await expectNothingLeftThePage(page, 2);
});

test('the switch off, then "Print full original text" ticked and unticked: the switch stays off, and on again brings the cards back as they were (task 7.8c)', async ({ page }) =>
{
    test.setTimeout(90_000);
    await open(page, [LAST], 4);
    const everything = page.getByRole('checkbox', { name: en.pdf.everything });
    const rebuild = page.getByRole('checkbox', { name: en.rebuilt.rebuildConversation });
    const cards = page.locator('#preview-list > li.message-rebuilt');
    await cards.nth(1).getByRole('checkbox').uncheck();
    await rebuild.uncheck();
    for (const card of await cards.all())
    {
        await expect(card).toBeHidden();
    }
    await everything.check();
    await expect(rebuild).not.toBeChecked();
    await expect(rebuild).toBeDisabled();
    await everything.uncheck();
    await expect(rebuild).toBeEnabled();
    await expect(rebuild).not.toBeChecked();
    await expect(page.locator('#review-rebuilt')).toBeHidden();
    await expect(page.locator('#review-messages')).toHaveText('1 email found.');
    for (const card of await cards.all())
    {
        await expect(card).toBeHidden();
    }
    const off = (await makePdfText(page)).join(' ');
    expect(off).not.toContain(heading(2));
    expect(off).not.toMatch(/rebuilt/i);
    await rebuild.check();
    await expect(page.locator('#review-rebuilt')).toHaveText('2 of 3 rebuilt emails will be in the PDF.');
    await expect(page.locator('#review-messages')).toHaveText('1 email found, 3 earlier emails rebuilt from quoted text.');
    const ticks = [true, false, true];
    for (const [k, card] of (await cards.all()).entries())
    {
        await expect(card).toBeVisible();
        await expect(card.getByRole('checkbox')).toBeChecked({ checked: ticks[k]! });
    }
    await expectNothingLeftThePage(page);
});

for (const [name, size] of [
    ['320 px wide', { width: 320, height: 640 }],
    ['200% zoom (640 CSS px wide)', { width: 640, height: 400 }],
] as const)
{
    test(`the full-text note and the disabled switch fit a ${name} screen and wrap, with no sideways scrolling (task 7.8c)`, async ({ page }) =>
    {
        test.setTimeout(90_000);
        await page.setViewportSize(size);
        await open(page, [LAST], 4);
        await page.getByRole('checkbox', { name: en.pdf.everything }).check();
        await expect(page.getByRole('checkbox', { name: en.rebuilt.rebuildConversation })).toBeDisabled();
        for (const selector of ['#pdf-everything-note', '#rebuilt-switch'])
        {
            const part = page.locator(selector);
            await expect(part).toBeVisible();
            const box = await part.boundingBox();
            expect(box, selector).not.toBeNull();
            expect(box!.x, selector).toBeGreaterThanOrEqual(0);
            expect(box!.x + box!.width, selector).toBeLessThanOrEqual(size.width);
        }
        // The note wraps over several lines rather than running off the page.
        expect((await page.locator('#pdf-everything-note').boundingBox())!.height).toBeGreaterThan(size.width < 400 ? 40 : 18);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        await expectNothingLeftThePage(page, 0);
    });
}

