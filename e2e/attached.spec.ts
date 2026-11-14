// Browser test of an email attached inside a dropped file (task 8.13b-3):
// the preview lists it as an email of its own with its own checkbox, the
// email holding it says its forwarded part is printed as that email, the
// label follows its checkbox (unticked: left out of the PDF, Q3), and the
// PDF made agrees: two emails, the forward printed once, its File row
// "file › attachment". Against the BUILT site, with the real pipeline. One
// synthetic file written here, in memory. Nothing may leave the page, no CSP
// violation, no console error (e2e/support/watch.ts).
import { readFileSync } from 'node:fs';
import { expect, test, type Download, type Locator, type Page } from '@playwright/test';
import { readPageRuns, readPdf, textLines } from '../tests/support/pdf-reader.ts';
import { en } from '../src/ui/i18n/en.ts';
import { engineOf, watchPage, withoutSelectConsole, withoutSelectReports, workerCspReports, type Watch } from './support/watch.ts';

declare global {
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

test.beforeEach(async ({ context, page, baseURL }) => {
  origin = new URL(baseURL ?? '').origin;
  problems = [];
  downloads = [];
  watch = await watchPage(context, page, origin);
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('download', (download) => downloads.push(download));
  await page.addInitScript(() => {
    window.__attachedViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__attachedViolations.push(`${event.effectiveDirective} ${event.blockedURI}${event.target instanceof HTMLSelectElement ? ' select' : ''}`);
    });
  });
});

async function expectReady(page: Page): Promise<void> {
  await expect(page.locator('#preview-list')).toHaveAttribute('data-pdf-labels', 'ready', { timeout: 15_000 });
}

async function labelsOf(item: Locator): Promise<string[]> {
  return (await item.locator('.pdf-label:visible').allTextContents()).map((s) => s.trim());
}

test('an attached email is an email of its own in the preview and in the PDF', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('#drop-zone')).toBeVisible();
  loadedAt = watch.requests.length;
  await page.locator('#file-input').setInputFiles([{ name: 'forward.eml', mimeType: 'message/rfc822', buffer: NodeBuffer.from(FILE, 'utf8') as never }]);
  await expect(page.locator('#add-summary-text')).toHaveText('1 file added. 2 emails found.', { timeout: 30_000 });

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
