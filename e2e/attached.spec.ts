// Browser test of an email attached inside a dropped file (task 8.13b-3):
// the preview lists it as an email of its own with its own checkbox, the
// email holding it says its forwarded part is printed as that email, the
// label follows its checkbox (unticked: left out of the PDF, Q3), and the
// PDF made agrees: two emails, the forward printed once, its File row
// "file › attachment". Task 8.13b-4: the "Attached to" / "Attached emails"
// rows (plain list numbers), "Also in" with the File row's chain, the note
// for an email sent as a file that could not be read (on its holder and on
// the email printing that one inline), the counts line, all written again
// on a language switch. Against the BUILT site, with the real pipeline.
// Synthetic files written here, in memory. Nothing may leave the page, no
// CSP violation, no console error (e2e/support/watch.ts).
import { readFileSync } from 'node:fs';
import { expect, test, type Download, type Locator, type Page } from '@playwright/test';
import { readPageRuns, readPdf, textLines } from '../tests/support/pdf-reader.ts';
import { en } from '../src/ui/i18n/en.ts';
import { fr } from '../src/ui/i18n/fr.ts';
import { nl } from '../src/ui/i18n/nl.ts';
import { engineOf, watchPage, withoutSelectConsole, withoutSelectReports, workerCspReports, type Watch } from './support/watch.ts';

declare global
{
    interface Window {
        __attachedViolations: string[];
    }
}

const NodeBuffer = (globalThis as unknown as { Buffer: { from(text: string, encoding: 'utf8'): Uint8Array } }).Buffer;

const OWN = 'Bob, the depot figures are below, as promised.';
const FORWARDED = 'The north depot counted forty two oak desks and sixty chairs on Friday afternoon.';
const FILE = [
    'From: Carol Test <carol@example.test>',
    'To: Bob Sample <bob@furniture.example.test>',
    'Date: Tue, 25 Mar 2025 10:00:00 +0100',
    'Subject: Fwd: Depot count',
    'Message-ID: <attached-e2e-forward@example.test>',
    'X-Synthetic-Fixture: true',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    '--outer',
    'Content-Type: text/plain; charset="us-ascii"',
    '',
    OWN,
    '--outer',
    'Content-Type: message/rfc822',
    '',
    'From: Depot Desk <depot@example.test>',
    'To: Carol Test <carol@example.test>',
    'Date: Fri, 21 Mar 2025 16:00:00 +0100',
    'Subject: Depot count',
    'Message-ID: <attached-e2e-count@example.test>',
    'X-Synthetic-Fixture: true',
    '',
    FORWARDED,
    '--outer--',
    '',
].join('\r\n');

const PRINTED_AS = (n: number): string => en.pdf.printedAs.email.replace('{number}', `#${String(n)}`);
const UNTICKED = (n: number): string => en.pdf.printedAs.untickedAttached.replace('{number}', `#${String(n)}`);
const squash = (s: string): string => s.replace(/\s+/gu, ' ').trim();

test.use({ timezoneId: 'Africa/Lagos' });

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
    page.on('download', (download) => downloads.push(download));
    await page.addInitScript(() =>
    {
        window.__attachedViolations = [];
        document.addEventListener('securitypolicyviolation', (event) =>
        {
            window.__attachedViolations.push(`${event.effectiveDirective} ${event.blockedURI}${event.target instanceof HTMLSelectElement ? ' select' : ''}`);
        });
    });
});

async function expectReady(page: Page): Promise<void>
{
    await expect(page.locator('#preview-list')).toHaveAttribute('data-pdf-labels', 'ready', { timeout: 15_000 });
}

async function labelsOf(item: Locator): Promise<string[]>
{
    return (await item.locator('.pdf-label:visible').allTextContents()).map((s) => s.trim());
}

test('an attached email is an email of its own in the preview and in the PDF', async ({ page }) =>
{
    test.setTimeout(90_000);
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('#drop-zone')).toBeVisible();
    loadedAt = watch.requests.length;
    await page.locator('#file-input').setInputFiles([{ name: 'forward.eml', mimeType: 'message/rfc822', buffer: NodeBuffer.from(FILE, 'utf8') as never }]);
    await expect(page.locator('#add-summary-text')).toHaveText('1 file added. 2 emails found (1 attached inside another email).', { timeout: 30_000 });

    const items = page.locator('#preview-list > li:not(.message-rebuilt)');
    await expect(items).toHaveCount(2);
    await expect(page.locator('#preview-list > li.message-rebuilt')).toHaveCount(0);
    // By date: the forwarded email (#1), then the forward (#2); each with its own checkbox.
    await expect(items.locator('.message-subject')).toHaveText(['Depot count', 'Fwd: Depot count']);
    await expect(items.nth(0).getByRole('checkbox', { name: en.actions.include })).toBeChecked();
    await expect(items.nth(1).getByRole('checkbox', { name: en.actions.include })).toBeChecked();
    await expectReady(page);
    expect(await labelsOf(items.nth(1))).toEqual([PRINTED_AS(1)]);

    // Unticked: left out of the PDF, and out of the forward too (Q3).
    await items.nth(0).getByRole('checkbox', { name: en.actions.include }).uncheck();
    await expectReady(page);
    await expect(items.nth(0)).toHaveAttribute('data-included', 'false');
    await expect(items.nth(1)).toHaveAttribute('data-included', 'true');
    expect(await labelsOf(items.nth(1))).toEqual([UNTICKED(1)]);

    // Ticked again, then the PDF.
    await items.nth(0).getByRole('checkbox', { name: en.actions.include }).check();
    await expectReady(page);
    expect(await labelsOf(items.nth(1))).toEqual([PRINTED_AS(1)]);
    const makeButton = page.getByRole('button', { name: en.actions.makePdf });
    await expect(makeButton).not.toHaveAttribute('aria-disabled', /.*/, { timeout: 60_000 });
    const next = page.waitForEvent('download', { timeout: 60_000 });
    await makeButton.click();
    const pdf = readPdf(new Uint8Array(readFileSync(await (await next).path())));
    const text = squash((await readPageRuns(pdf)).map((runs) => textLines(runs).map((l) => l.shown).join(' ')).join(' '));
    expect(text.split(squash(FORWARDED)).length - 1).toBe(1);
    expect(text).toContain(OWN);
    expect(text).toContain('forward.eml › (attached email 1)');
    expect(text).not.toContain('Forwarded message');

    // Nothing left the page.
    await page.waitForTimeout(500);
    const workerUrls = new Set(watch.workers.map((w) => w.url()));
    const pdfUrl = await page.locator('#download-link').getAttribute('href');
    const others = watch.requests.slice(loadedAt).filter((url) => !workerUrls.has(url) && url !== pdfUrl);
    expect(others).toEqual([]);
    expect(watch.requests.every((url) => url.startsWith('blob:') || new URL(url).origin === origin)).toBe(true);
    expect(watch.websockets).toEqual([]);
    const browserName = engineOf(page.context());
    expect(withoutSelectReports(browserName, await page.evaluate(() => window.__attachedViolations))).toEqual([]);
    expect(workerCspReports(watch)).toEqual([]);
    expect(withoutSelectConsole(browserName, problems)).toEqual([]);
    expect(downloads).toHaveLength(1);
});

// Task 8.13b-4. holder.eml: Carol's email, holding Bob's email inline (Bob's
// own email holds broken.eml as a file, which cannot be read: nothing in
// it) and Alice's email as a file (alice-fwd.eml). alice.eml: the same email
// of Alice, dropped too, so the attached copy is merged into it.
const part = (...lines: string[]): string => lines.join('\r\n');
const ALICE_EMAIL = part(
    'From: Alice Example <alice@example.test>',
    'To: Carol Test <carol@example.test>',
    'Date: Mon, 24 Mar 2025 09:00:00 +0100',
    'Subject: Desk order',
    'Message-ID: <attached-e2e-alice@example.test>',
    'X-Synthetic-Fixture: true',
    '',
    'Carol, please order six oak desks for the north office before the end of the month.',
);
const BOB_EMAIL = part(
    'From: Bob Sample <bob@furniture.example.test>',
    'To: Carol Test <carol@example.test>',
    'Date: Tue, 25 Mar 2025 09:00:00 +0100',
    'Subject: Desk delivery',
    'Message-ID: <attached-e2e-bob@example.test>',
    'X-Synthetic-Fixture: true',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="bob"',
    '',
    '--bob',
    'Content-Type: text/plain; charset="us-ascii"',
    '',
    'The six desks can be delivered on Thursday morning; the old order form is attached.',
    '--bob',
    'Content-Type: message/rfc822',
    'Content-Disposition: attachment; filename="broken.eml"',
    '',
    '',
    '--bob--',
);
const HOLDER = part(
    'From: Carol Test <carol@example.test>',
    'To: Dan Example <dan@example.test>',
    'Date: Wed, 26 Mar 2025 09:00:00 +0100',
    'Subject: Fwd: Desk delivery',
    'Message-ID: <attached-e2e-holder@example.test>',
    'X-Synthetic-Fixture: true',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="carol"',
    '',
    '--carol',
    'Content-Type: text/plain; charset="us-ascii"',
    '',
    'Dan, Bob confirmed the delivery below; Alice asked for it in the email attached.',
    '--carol',
    'Content-Type: message/rfc822',
    '',
    BOB_EMAIL,
    '--carol',
    'Content-Type: message/rfc822',
    'Content-Disposition: attachment; filename="alice-fwd.eml"',
    '',
    ALICE_EMAIL,
    '--carol--',
    '',
);

test('attached emails: where they come from, the unread note and the counts, in every language (task 8.13b-4)', async ({ page }) =>
{
    test.setTimeout(90_000);
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('#drop-zone')).toBeVisible();
    loadedAt = watch.requests.length;
    await page.locator('#file-input').setInputFiles([
        { name: 'holder.eml', mimeType: 'message/rfc822', buffer: NodeBuffer.from(HOLDER, 'utf8') as never },
        { name: 'alice.eml', mimeType: 'message/rfc822', buffer: NodeBuffer.from(`${ALICE_EMAIL}\r\n`, 'utf8') as never },
    ]);
    // Carol's, Bob's, Alice's attached copy and alice.eml: 4 found, 2 of them attached, 1 merged.
    await expect(page.locator('#add-summary-text')).toHaveText('2 files added. 4 emails found (2 attached inside other emails). 1 identical copy merged.', {
        timeout: 30_000,
    });
    await expect(page.locator('#review-messages')).toHaveText('4 emails found (2 attached inside other emails), 1 identical copy merged.');

    const items = page.locator('#preview-list > li:not(.message-rebuilt)');
    await expect(items.locator('.message-subject')).toHaveText(['Desk order', 'Desk delivery', 'Fwd: Desk delivery']);
    const [alice, bob, carol] = [items.nth(0), items.nth(1), items.nth(2)];
    await expectReady(page);

    // Where each one comes from: plain list numbers (Q4), and the File row's chain in "Also in" (P2).
    await expect(alice.locator('dt.meta-attached-to')).toHaveText(en.preview.attachedTo);
    await expect(alice.locator('dd.meta-attached-to')).toHaveText('email #3');
    await expect(alice.locator('dd.meta-also-in')).toHaveText('holder.eml › alice-fwd.eml');
    await expect(bob.locator('dd.meta-attached-to')).toHaveText('email #3');
    await expect(carol.locator('dt.meta-attached-emails')).toHaveText(en.preview.attachedEmails);
    await expect(carol.locator('dd.meta-attached-emails')).toHaveText('#1, #2');
    await expect(carol.locator('dd.meta-attached-to')).toHaveCount(0);
    // Nothing to click or Tab to in these rows.
    await expect(page.locator('#preview-list dd:is(.meta-attached-to, .meta-attached-emails) :is(a, button, [tabindex])')).toHaveCount(0);

    // The unread email sent as a file: noted on Bob's email and on Carol's, which prints Bob's inline (Q5).
    await expect(bob.locator('.message-note[data-code="attached-unread"]')).toHaveText(en.warnings.attached['attached-unread']);
    await expect(carol.locator('.message-note[data-code="attached-unread-inside"]')).toHaveText(en.warnings.attached['attached-unread-inside']);
    await expect(alice.locator('.message-note[data-code^="attached-unread"]')).toHaveCount(0);

    // Unticking the holder changes no number.
    await carol.getByRole('checkbox', { name: en.actions.include }).uncheck();
    await expectReady(page);
    await expect(alice.locator('dd.meta-attached-to')).toHaveText('email #3');
    await expect(carol.locator('dd.meta-attached-emails')).toHaveText('#1, #2');

    // French, then Dutch: every new word written again in place, the numbers kept.
    await page.locator('#lang-fr').check();
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(alice.locator('dt.meta-attached-to')).toHaveText(fr.preview.attachedTo);
    await expect(alice.locator('dd.meta-attached-to')).toHaveText('l’e-mail #3');
    await expect(alice.locator('dd.meta-also-in')).toHaveText('holder.eml › alice-fwd.eml');
    await expect(carol.locator('dt.meta-attached-emails')).toHaveText(fr.preview.attachedEmails);
    await expect(carol.locator('dd.meta-attached-emails')).toHaveText('#1 et #2');
    await expect(bob.locator('.message-note[data-code="attached-unread"]')).toHaveText(fr.warnings.attached['attached-unread']);
    await expect(page.locator('#review-messages')).toHaveText('4 e-mails trouvés (2 joints à d’autres e-mails) et 1 copie identique fusionnée.');
    await expect(page.locator('#add-summary-text')).toContainText('4 e-mails trouvés (2 joints à d’autres e-mails).');
    await page.locator('#lang-nl').check();
    await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
    await expect(alice.locator('dt.meta-attached-to')).toHaveText(nl.preview.attachedTo);
    await expect(alice.locator('dd.meta-attached-to')).toHaveText('e-mail #3');
    await expect(carol.locator('dt.meta-attached-emails')).toHaveText(nl.preview.attachedEmails);
    await expect(carol.locator('.message-note[data-code="attached-unread-inside"]')).toHaveText(nl.warnings.attached['attached-unread-inside']);
    await expect(page.locator('#review-messages')).toContainText('(2 bijgevoegd bij andere e-mails)');
    await page.locator('#lang-en').check();
    await expect(alice.locator('dd.meta-attached-to')).toHaveText('email #3');

    // "Clear everything": nothing of it left.
    await page.getByRole('button', { name: en.actions.clearEverything }).click();
    await expect(page.locator('#preview-list > li')).toHaveCount(0);
    await expect(page.locator('#review-messages')).toHaveText('');

    // Nothing left the page.
    await page.waitForTimeout(500);
    const workerUrls = new Set(watch.workers.map((w) => w.url()));
    const others = watch.requests.slice(loadedAt).filter((url) => !workerUrls.has(url));
    expect(others).toEqual([]);
    expect(watch.websockets).toEqual([]);
    const browserName = engineOf(page.context());
    expect(withoutSelectReports(browserName, await page.evaluate(() => window.__attachedViolations))).toEqual([]);
    expect(workerCspReports(watch)).toEqual([]);
    expect(withoutSelectConsole(browserName, problems)).toEqual([]);
});
