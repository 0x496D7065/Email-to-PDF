// Browser test of the cards of earlier emails rebuilt from quoted text in
// step 2 (milestone 7, task 7.6: Source/web-page/preview.ts, Source/web-page/review.ts,
// Source/web-page-logic/rebuilt-email-display.ts), in each test browser against the BUILT site
// served by `vite preview` (see playwright.config.ts).
//
// The file added is the LAST email of a synthetic thread
// (Helper/Test/test-data/eml/13-order-4-bob-outlook-nl.eml): its quote holds the
// three earlier emails, written by three mail programs (an Outlook block in
// Dutch, a Gmail ">" quote, an Outlook block in English inside it). Alone,
// it gives three rebuilt cards before its own card.
//
// Every test also checks, once everything has settled, that nothing left the
// page (only the inlined workers' blob: URLs), that there was no CSP
// violation (page or worker) and no console error, except the reports Chromium
// makes while DOMParser PARSES email HTML (inline styles in fixture 98; nothing
// runs or loads: see Helper/Test/browser-tests/html-to-text.spec.ts) and their console lines.
// See Helper/Test/browser-tests/support/network-and-csp-watch.ts.
// The accessibility checks of this state are in Helper/Test/browser-tests/accessibility.spec.ts.
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../../../Source/web-page/translations/en.ts';
import { readPageRuns, readPdf, textLines } from '../test-support/pdf-reader.ts';
import { phoneForwardParts, phoneForwardThread } from '../test-support/phone-forward-thread.ts';
import { browserEngineOf, isParseTimeReport, PARSE_TIME_CONSOLE, untoleratedReports, watchPage,
    workerCspReports, type PageWatch } from './support/network-and-csp-watch.ts';

declare global
{
    interface Window
    {
        __rebuiltViolations: string[];
    }
}

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('../../..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

/** Node's Buffer (see Helper/Test/browser-tests/add-files.spec.ts): what setInputFiles wants for in-memory files. */
const NodeBuffer = (globalThis as unknown as { Buffer: { from(bytes: Uint8Array): Uint8Array } }).Buffer;

/** A fixture as an in-memory file (the fixtures are 7-bit ASCII text). */
const fixture = (name: string): { name: string; mimeType: string; buffer: never } => ({
    name,
    mimeType: 'message/rfc822',
    buffer: NodeBuffer.from(new TextEncoder().encode(readFileSync(`${ROOT}Helper/Test/test-data/eml/${name}`, 'utf8'))) as never,
});

const LAST = fixture('13-order-4-bob-outlook-nl.eml');

/** The fixed notes, as the cards show them (source email #1). */
const NOTE_MARKS = en.rebuilt.noteMarks.replace('{number}', '#1');
const NOTE_NO_MARKS = en.rebuilt.noteNoMarks.replace('{number}', '#1');

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
        window.__rebuiltViolations = [];
        // An inline report made while DOMParser parses is fired at the document;
        // an inline one about the live page at the element concerned.
        document.addEventListener('securitypolicyviolation', (event) =>
        {
            const where = event.target === document ? 'parse' : 'live';
            window.__rebuiltViolations.push(`${event.effectiveDirective} ${event.blockedURI} ${where}`);
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

/**
 * Nothing left the page, no CSP violation, no console error (see Helper/Test/browser-tests/review.spec.ts);
 * at most `pdfs` own-origin blob: URLs besides the workers (a PDF made: Chromium may list its download as a request).
 */
async function expectNothingLeftThePage(page: Page, pdfs = 0): Promise<void>
{
    await page.waitForTimeout(500);
    const ownBlob = new RegExp(`^blob:${origin}/[0-9a-f-]+$`);
    const workerUrls = new Set(watch.workers.map((w) => w.url()));
    for (const url of workerUrls)
    {
        expect(url).toMatch(ownBlob);
    }
    const others = watch.requests.slice(loadedAt).filter((url) => !workerUrls.has(url));
    expect(others.length).toBeLessThanOrEqual(pdfs);
    for (const url of others)
    {
        expect(url).toMatch(ownBlob);
    }
    expect(watch.requests.every((url) => new URL(url).origin === origin)).toBe(true);
    expect(watch.websockets).toEqual([]);
    const browserName = browserEngineOf(page.context());
    const violations = await page.evaluate(() => window.__rebuiltViolations);
    expect(untoleratedReports(browserName, violations)).toEqual([]);
    expect(workerCspReports(watch)).toEqual([]);
    // One console line at most per tolerated parse-time report (as in Helper/Test/browser-tests/full-flow.spec.ts).
    const directives = violations.filter(isParseTimeReport).map((v) => v.split(' ')[0] ?? '');
    const consoleProblems = problems;
    for (const known of PARSE_TIME_CONSOLE)
    {
        const lines = consoleProblems.filter((p) => known.line.test(p)).length;
        expect(lines).toBeLessThanOrEqual(directives.filter((d) => known.directives.includes(d)).length);
    }
    expect(consoleProblems.filter((p) => !PARSE_TIME_CONSOLE.some((known) => known.line.test(p)))).toEqual([]);
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
    // The newest quoted email: an Outlook block in Dutch; its time as written, never converted and never
    // "about" (task 9.9c), and the date text as written too.
    const newest = rebuilt.nth(2);
    await expect(newest.locator('.message-subject')).toHaveText('Re: Office desks and chairs');
    await expect(newest.locator('dd.meta-author')).toHaveText('Alice Example <alice@example.test>');
    await expect(newest.locator('dd.meta-date')).toHaveText('2025-03-03 15:40 As written in the quote: maandag 3 maart 2025 15:40');
    // The Gmail quote: an attribution line holds no subject, so the card shows the subject of the
    // header above it (user decision F3, task 9.9a); its text without the ">" marks.
    const gmail = rebuilt.nth(1);
    await expect(gmail.locator('.message-subject')).toHaveText('Re: Office desks and chairs');
    const text = (await gmail.locator('.body-text').allTextContents()).join('');
    expect(text).toContain('Thank you for your message.');
    expect(text).not.toMatch(/^>/m);
    // Its signature and disclaimer, folded as in a real email (task 9.9b-2, user decision F4), one click away.
    const fold = gmail.locator('details.fold');
    await expect(fold).toHaveCount(1);
    await expect(fold).not.toHaveAttribute('open', /.*/);
    await expect(fold.locator('.fold-what')).toHaveText(/^Signature or repeated notice, \d+ lines$/);
    await expect(fold.locator('.pdf-label')).toHaveText(`${en.pdf.label.in.replace('{reasons}', en.pdf.reason.signature)}`);
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
    for (const card of await page.locator('#preview-list > li.message-rebuilt').all())
    {
        await expect(card).toBeHidden();
    }
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
    // The toolbar's first control (there is no time-zone list any more, task 9.9c).
    await page.locator('#preview-show-folded').focus();
    const order: string[] = [];
    for (let i = 0; i < 6; i++)
    {
        await page.keyboard.press('Tab');
        order.push(await page.evaluate(() => document.activeElement?.id ?? ''));
    }
    // Each card's folded signature (task 9.9b-2) is a Tab stop too, after its checkbox, as a fold in a real email.
    const summaries = await page.locator('#preview-list > li.message-rebuilt details.fold > summary').count();
    expect(summaries).toBe(3);
    expect(order).toEqual(['pdf-everything', 'rebuilt-include-all', 'include-rebuilt-2', '', 'include-rebuilt-1', '']);

    const card = page.locator('#preview-list > li.message-rebuilt').nth(1);
    await card.getByRole('checkbox').focus();
    await page.keyboard.press('Space');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-included', 'false');
    await expect(card.locator('.excluded-note')).toHaveText(en.review.excluded);
    await expect(page.locator('#review-rebuilt')).toHaveText('2 of 3 rebuilt emails will be in the PDF. Left out: 1 is unticked.');
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

// Task 9.9a: a phone forward of a long FLAT thread, as an Android mail app writes it (fixture 98: HTML
// only, each forward's body one blockquote deeper than its header lines, Outlook HTML inside, "&nbsp;"
// before the colons, a tab in a quoted display name). Converted by the real DOMParser path, it must give
// the 13 earlier emails of Helper/Test/test-support/phone-forward-thread.ts (the French form), 3 of them
// with no text (left out of the PDF), not one unfolded block.
test('a phone forward of a flat thread (Android HTML): 13 rebuilt cards, field by field, 10 in the PDF', async ({ page }) =>
{
    test.setTimeout(60_000);
    await page.goto('/', { waitUntil: 'networkidle' });
    loadedAt = watch.requests.length;
    await page.locator('#file-input').setInputFiles([fixture('98-phone-forward-android-html.eml')]);
    await expect(page.locator('#add-summary-text')).toHaveText('1 file added. 1 email found.', { timeout: 30_000 });
    await expect(page.locator('#preview-list > li')).toHaveCount(14);
    await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/);
    await expect(page.locator('#review-messages')).toHaveText('1 email found, 13 earlier emails rebuilt from quoted text.');
    await expect(page.locator('#review-rebuilt')).toHaveText('10 of 13 rebuilt emails will be in the PDF. Left out: 3 have no text.');

    // Oldest first, as the list shows them.
    const expected = [...phoneForwardThread('fr').expected].reverse();
    const cards = page.locator('#preview-list > li.message-rebuilt');
    await expect(cards).toHaveCount(13);
    const box = (who: { readonly name: string; readonly address: string }): string => (who.name === '' ? who.address : `${who.name} <${who.address}>`);
    await expect(cards.locator('dd.meta-author')).toHaveText(expected.map((e) => box(e.from)));
    await expect(cards.locator('.message-subject')).toHaveText(expected.map((e) => e.subject));
    for (const [k, want] of expected.entries())
    {
        const card = cards.nth(k);
        const where = `card ${String(k + 1)} (${want.dateText})`;
        await expect(card.locator('dd.meta-date'), where).toContainText(`As written in the quote: ${want.dateText}`);
        await expect(card.locator('dd.meta-cc'), where).toHaveCount(want.cc.length === 0 ? 0 : 1);
        if (want.noOwnText)
        {
            await expect(card.locator('.body-empty'), where).toHaveText(en.preview.notInPdfNoText);
            continue;
        }
        const text = ((await card.locator('.body-text').allTextContents()).join('')).replace(/\s+/gu, ' ').trim();
        expect(text.startsWith(want.first), `${where}: starts with "${want.first}"`).toBe(true);
        expect(text.endsWith(want.last), `${where}: ends with "${want.last}"`).toBe(true);
    }
    await expectNothingLeftThePage(page);
});

// Task 9.9b (user decision F2, 2026-11-19): the 3 empty emails of fixture 98 put nothing in the PDF, not even
// their header lines: the lines of the empty forward at the top ("17 nov. 2026 19:23") and of the empty
// attribution over 27 Sep 08:27 ("27 sept. 2026 08:31") are printed nowhere. The preview keeps them in the
// file's text, labelled. Task 9.9e: the file's own email is left out too, all of its text being printed as
// the rebuilt emails, so the PDF holds the 10 rebuilt emails only: no "(no text)" block, a cover and an
// index of 10. The preview still lists the file's email, with a note saying why it is not in the PDF.
test('a phone forward of a flat thread (Android HTML): the empty emails put nothing in the PDF, the preview says so', async ({ page }) =>
{
    test.setTimeout(90_000);
    await page.goto('/', { waitUntil: 'networkidle' });
    loadedAt = watch.requests.length;
    await page.locator('#file-input').setInputFiles([fixture('98-phone-forward-android-html.eml')]);
    await expect(page.locator('#add-summary-text')).toHaveText('1 file added. 1 email found.', { timeout: 30_000 });
    await expect(page.locator('#preview-list > li')).toHaveCount(14);
    await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/);
    await expect(page.locator('#preview-list')).toHaveAttribute('data-pdf-labels', 'ready');
    const file = page.locator('#preview-list > li:not(.message-rebuilt)');
    await expect(file).toHaveCount(1);
    await expect(file.locator('.pdf-label', { hasText: en.pdf.printedAs.noText })).not.toHaveCount(0);
    await expect(file.locator('.pdf-label', { hasText: en.pdf.printedAs.notRebuilt })).toHaveCount(0);
    await expect(file.locator('.pdf-note')).toBeVisible();
    await expect(file.locator('.pdf-note')).toHaveText(en.review.pdfNote['pdf-all-printed-elsewhere']);

    const makeButton = page.getByRole('button', { name: en.actions.makePdf });
    await expect(makeButton).not.toHaveAttribute('aria-disabled', /.*/, { timeout: 60_000 });
    const next = page.waitForEvent('download', { timeout: 60_000 });
    await makeButton.click();
    const bytes = new Uint8Array(readFileSync(await (await next).path()));
    const text = (await readPageRuns(readPdf(bytes))).map((runs) => textLines(runs).map((l) => l.shown).join(' ')).join(' ');
    const heading = (n: number): string => en.pdf.document.emailHeading.replace('{number}', String(n));
    for (let n = 1; n <= 10; n++)
    {
        expect(text.split(`${heading(n)} From`), heading(n)).toHaveLength(2);
    }
    expect(text).not.toContain(`${heading(11)} From`);
    // Task 9.9e: no "(no text)" block, the cover counts 10 emails, and the file's email (its File row) is not printed.
    expect(text).not.toContain(en.preview.noText);
    expect(text).toContain(en.pdf.document.emailCount.other.replace('{count}', '10'));
    expect(text).not.toContain('98-phone-forward-android-html.eml');
    expect(text).not.toContain('17 nov. 2026 19:23');
    expect(text).not.toContain('27 sept. 2026 08:31');
    // Task 9.9b-2 (user decision F4): the workshop's 15-line signature is folded in its 4 rebuilt emails,
    // printed in the first one only; the preview's labels say the same.
    const signatureLine = 'Zone artisanale Exemple, hall B';
    expect(text.split(signatureLine)).toHaveLength(2);
    const rebuiltFolds = page.locator('#preview-list > li.message-rebuilt details.fold');
    await expect(rebuiltFolds).toHaveCount(4);
    const signatureIn = en.pdf.label.in.replace('{reasons}', en.pdf.reason.signature);
    const signatureOut = en.pdf.label.out.replace('{reasons}', en.pdf.reason['repeated-signature']);
    await expect(rebuiltFolds.locator('.pdf-label')).toHaveText([signatureIn, signatureOut, signatureOut, signatureOut]);
    for (const fold of await rebuiltFolds.all())
    {
        await expect(fold.locator('.body-folded')).toContainText(signatureLine);
    }
    await expectNothingLeftThePage(page, 1);
});

// Task 9.9b-4: the phone forward as plain text (fixtures 94 to 97: the same 13 earlier emails, 3 of them empty), each
// file alone and the four together. Together, the copies of each earlier email are linked (the 3 empty ones by their
// header facts), so step 2 counts 13 rebuilt emails, not 22. In every run the PDF prints each of the 10 rebuilt emails
// with text exactly once and no header lines of the 3 empty ones. Task 9.9e: the files' own emails are not in the PDF
// (all of their text is printed as the rebuilt emails): 10 emails, no "(no text)" block.
const PLAIN_PHONE_FORWARDS = ['94-phone-forward-flat.eml', '95-phone-forward-wrapped.eml', '96-phone-forward-cut-address.eml', '97-phone-forward-alternative.eml'];
for (const names of [...PLAIN_PHONE_FORWARDS.map((name) => [name]), PLAIN_PHONE_FORWARDS])
{
    const label = names.length === 1 ? (names[0] as string) : '94 to 97 together';
    test(`a phone forward of a flat thread (plain text), ${label}: 10 of 13 rebuilt emails in the PDF, each once, no header-only blocks`, async ({ page }) =>
    {
        test.setTimeout(120_000);
        await page.goto('/', { waitUntil: 'networkidle' });
        loadedAt = watch.requests.length;
        await page.locator('#file-input').setInputFiles(names.map(fixture));
        const files = names.length;
        await expect(page.locator('#add-summary-text')).toHaveText(files === 1 ? '1 file added. 1 email found.' : `${String(files)} files added. ${String(files)} emails found.`,
            { timeout: 30_000 });
        await expect(page.locator('#preview-list > li')).toHaveCount(13 + files);
        await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/);
        await expect(page.locator('#review-rebuilt')).toHaveText('10 of 13 rebuilt emails will be in the PDF. Left out: 3 have no text.');
        await expect(page.locator('#preview-list > li.message-rebuilt')).toHaveCount(13);

        const makeButton = page.getByRole('button', { name: en.actions.makePdf });
        await expect(makeButton).not.toHaveAttribute('aria-disabled', /.*/, { timeout: 60_000 });
        const next = page.waitForEvent('download', { timeout: 60_000 });
        await makeButton.click();
        const bytes = new Uint8Array(readFileSync(await (await next).path()));
        const squash = (text: string): string => text.replace(/\s+/gu, ' ').trim();
        const text = squash((await readPageRuns(readPdf(bytes))).map((runs) => textLines(runs).map((l) => l.shown).join(' ')).join(' '));
        const count = (part: string): number => text.split(part).length - 1;
        // The 10 rebuilt emails, numbered; the files' own emails are left out (task 9.9e).
        const heading = (n: number): string => en.pdf.document.emailHeading.replace('{number}', String(n));
        for (let n = 1; n <= 10; n++)
        {
            expect(count(`${heading(n)} From`), heading(n)).toBe(1);
        }
        expect(text).not.toContain(`${heading(11)} From`);
        expect(text).not.toContain(en.preview.noText);
        expect(count(en.pdf.document.emailCount.other.replace('{count}', '10'))).toBe(1);
        for (const name of names)
        {
            expect(text).not.toContain(name);
        }
        // Each rebuilt email with text once: its longest line that no other earlier email has (not a signature line).
        const parts = phoneForwardParts('fr').parts;
        const linesOf = (part: (typeof parts)[number]): string[] => part.body.flatMap((p) => p.split('\n')).map(squash).filter((l) => l !== '');
        const everyLine = parts.flatMap(linesOf);
        const withText = parts.filter((p) => !p.expected.noOwnText);
        expect(withText).toHaveLength(10);
        for (const part of withText)
        {
            const own = linesOf(part).filter((l) => everyLine.filter((x) => x === l).length === 1).sort((a, b) => b.length - a.length)[0];
            expect(own, part.expected.dateText).toBeDefined();
            expect(count(own as string), `${part.expected.dateText}: "${own as string}"`).toBe(1);
        }
        // The workshop's signature once (folded in its 4 emails, printed in the first: task 9.9b-2).
        expect(count('Zone artisanale Exemple, hall B')).toBe(1);
        // No header lines of the 3 empty emails: the empty forward at the top and the empty attribution over 27 Sep
        // 08:27 are printed nowhere; the empty 14 Jul attribution has the very words of the one with text under it,
        // whose attribution line is printed exactly once, as the first body line over that text (0 would mean the
        // email with text lost its attribution line).
        expect(text).not.toContain('17 nov. 2026 19:23');
        expect(text).not.toContain('27 sept. 2026 08:31');
        expect(count('14 juil. 2026 16:53')).toBe(1);
        await expectNothingLeftThePage(page, 1);
    });
}
